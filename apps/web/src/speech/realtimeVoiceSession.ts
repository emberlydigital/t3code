import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  IDLE_REALTIME_VOICE_CALL,
  RealtimeVoiceCall,
  realtimeVoiceOpeningContext,
  realtimeVoiceThreadSnapshot,
  startRealtimeVoiceCall,
  type RealtimeVoiceCallState,
  type RealtimeVoiceTransport,
  updateVoiceGoals,
  waitForVoiceCallHangUp,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  CloudSpeechError,
  DEFAULT_REALTIME_VOICE,
  isRealtimeVoiceName,
  MessageId,
  type RealtimeVoiceName,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { REALTIME_VOICE_DATA_CHANNEL } from "@t3tools/shared/realtimeVoice";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { getClientSettings } from "../hooks/useSettings";
import { newMessageId } from "../lib/utils";
import { appAtomRegistry, subscribeAtomChanges } from "../rpc/atomRegistry";
import { readPreparedConnection, readEnvironmentScope } from "../state/session";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { DEFAULT_INTERACTION_MODE } from "../types";
import { playCallEndSound, playCallStartSound } from "./callSounds";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";

const DISCLOSED_KEY = "t3code:voice-chat-disclosed:v2";
const FADE_MS = 180;
const FADE_STEPS = 12;
const isCloudSpeechError = Schema.is(CloudSpeechError);

/** A voice saved for an earlier voice list falls back to the default. */
export function resolveVoiceChatVoice(saved: string): RealtimeVoiceName {
  return isRealtimeVoiceName(saved) ? saved : DEFAULT_REALTIME_VOICE;
}

interface RealtimeVoiceState extends RealtimeVoiceCallState {
  readonly threadRef: ScopedThreadRef | null;
  readonly threadKey: string | null;
}

const IDLE: RealtimeVoiceState = { ...IDLE_REALTIME_VOICE_CALL, threadRef: null, threadKey: null };

/** The one live voice call this window can hold, and the thread it belongs to. */
export const useRealtimeVoiceStore = create<RealtimeVoiceState>(() => IDLE);

let currentCall: RealtimeVoiceCall | null = null;

export function stopRealtimeVoice() {
  currentCall?.end();
}

/** Stops or resumes sending the microphone. The call stays open and can still be heard. */
export function toggleRealtimeVoiceMute() {
  currentCall?.toggleMute();
}

function readThread(threadRef: ScopedThreadRef) {
  return appAtomRegistry.get(environmentThreadDetails.threadAtom(threadRef))?.projection ?? null;
}

/** The call sends audio off this device, so the first one says where it goes. */
async function disclosed() {
  try {
    if (window.localStorage.getItem(DISCLOSED_KEY) !== null) return true;
    const accepted =
      (await requestConfirmDialog(
        "Voice chat uses your ChatGPT account. Your audio and this thread are sent to OpenAI during the call.",
      )) ?? false;
    if (accepted) window.localStorage.setItem(DISCLOSED_KEY, "1");
    return accepted;
  } catch {
    return false;
  }
}

function failureMessage(cause: unknown) {
  if (isCloudSpeechError(cause)) return cause.message;
  if (cause instanceof DOMException && cause.name === "NotAllowedError")
    return "Allow microphone access to start a voice chat.";
  if (cause instanceof DOMException && cause.name === "NotFoundError")
    return "No microphone was found.";
  return "The voice chat could not be started. Try again.";
}

async function openBrowserTransport(): Promise<RealtimeVoiceTransport> {
  const microphoneId = getClientSettings().voiceMicrophone;
  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
    },
  });
  const setMicrophoneEnabled = (enabled: boolean) => {
    for (const track of media.getAudioTracks()) track.enabled = enabled;
  };
  const peer = new RTCPeerConnection();
  const speaker = new Audio();
  speaker.autoplay = true;
  peer.ontrack = (event) => {
    speaker.srcObject = event.streams[0] ?? null;
  };
  for (const track of media.getAudioTracks()) peer.addTrack(track, media);
  const channel = peer.createDataChannel(REALTIME_VOICE_DATA_CHANNEL);
  let fade: ReturnType<typeof setInterval> | undefined;
  return {
    createOffer: async () => {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      return offer.sdp ?? "";
    },
    acceptAnswer: (sdp) => peer.setRemoteDescription({ type: "answer", sdp }),
    send: (data) => {
      if (channel.readyState === "open") channel.send(data);
    },
    onOpen: (listener) => channel.addEventListener("open", listener),
    onMessage: (listener) =>
      channel.addEventListener("message", (event) => listener(String(event.data))),
    onLost: (listener) => {
      channel.addEventListener("close", listener);
      peer.addEventListener("connectionstatechange", () => {
        if (peer.connectionState === "failed" || peer.connectionState === "closed") listener();
      });
    },
    setMicrophoneEnabled,
    // Stepping the element's volume keeps the browser's echo cancellation, which Web Audio routing can lose.
    fadeOut: () => {
      const start = speaker.volume;
      let step = 0;
      fade = setInterval(() => {
        step += 1;
        const remaining = 1 - step / FADE_STEPS;
        speaker.volume = Math.max(0, start * remaining * remaining);
        if (step >= FADE_STEPS) clearInterval(fade);
      }, FADE_MS / FADE_STEPS);
      return FADE_MS + 20;
    },
    close: () => {
      clearInterval(fade);
      peer.close();
      speaker.srcObject = null;
      for (const track of media.getTracks()) track.stop();
    },
  };
}

/** Starts a live voice call about `threadRef`, ending any call already open in this window. */
export async function startRealtimeVoice(threadRef: ScopedThreadRef) {
  stopRealtimeVoice();
  const prepared = readPreparedConnection(threadRef.environmentId);
  if (
    prepared === null ||
    !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
  ) {
    toastManager.add({ type: "error", title: "This environment is not available for voice chat." });
    return;
  }
  if (!(await disclosed())) return;

  const threadKey = scopedThreadKey(threadRef);
  const call: RealtimeVoiceCall = new RealtimeVoiceCall({
    openTransport: openBrowserTransport,
    answerOffer: (offer) =>
      runEnvironmentSpeech(
        startRealtimeVoiceCall(
          prepared,
          offer,
          resolveVoiceChatVoice(getClientSettings().voiceChatVoice),
          realtimeVoiceOpeningContext(readThread(threadRef)),
        ),
      ),
    dispatch: async (messageId, text, steer) => {
      const projection = readThread(threadRef);
      if (projection === null) throw new Error("The thread is no longer available.");
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.startTurn,
        {
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            message: {
              messageId: MessageId.make(messageId),
              role: "user",
              text,
              attachments: [],
              context: { version: 1, source: "voice", records: [] },
            },
            runtimeMode: projection.thread.runtimeMode,
            interactionMode: DEFAULT_INTERACTION_MODE,
            dispatchMode: steer ? "steer" : "auto",
          },
        },
        { label: "voice chat request" },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    newMessageId,
    readThread: () => realtimeVoiceThreadSnapshot(readThread(threadRef)),
    // Structure changes only: streamed text arrives several times a second and is read when it settles.
    subscribeThread: (onChange) =>
      subscribeAtomChanges(environmentThreadDetails.quietThreadAtom(threadRef), onChange),
    updateGoals: (goals, update) =>
      runEnvironmentSpeech(updateVoiceGoals(prepared, goals, update)).then(
        (result) => result.goals,
      ),
    waitForHangUp: (signal) =>
      runEnvironmentSpeech(waitForVoiceCallHangUp(prepared, threadRef.threadId), { signal }),
    onState: (state) => {
      // A call replaced by a newer one no longer owns the store.
      if (currentCall !== call) return;
      useRealtimeVoiceStore.setState(
        state.status === "idle" ? IDLE : { ...state, threadRef, threadKey },
      );
      if (state.status === "idle") currentCall = null;
    },
    onLost: () =>
      toastManager.add({
        type: "warning",
        title: "Voice chat ended",
        description: "The call was disconnected.",
      }),
    onFailed: (cause) =>
      toastManager.add({
        type: "error",
        title: "Voice chat could not start",
        description: failureMessage(cause),
      }),
    playStartSound: playCallStartSound,
    playEndSound: playCallEndSound,
  });
  currentCall = call;
  await call.start();
}
