import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { deriveThreadStructureRuntime } from "@t3tools/client-runtime/state/thread-execution";
import {
  RealtimeVoiceConversation,
  startRealtimeVoiceCall,
  type RealtimeVoiceActivity,
  type RealtimeVoiceCaption,
  type RealtimeVoiceRequest,
  type RealtimeVoiceThreadSnapshot,
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
  type VoiceGoal,
  type VoiceGoalUpdate,
} from "@t3tools/contracts";
import { fallbackVoiceGoals } from "@t3tools/shared/voiceGoals";
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

/** How many of the thread's newest messages each change re-reads. */
const RECENT_MESSAGES = 40;
const CONTEXT_MAX_CHARS = 3000;
const DISCLOSED_KEY = "t3code:voice-chat-disclosed:v2";

/** Resolves once the voice model is not speaking, or after `maxMs`, plus a moment for the audio to drain. */
function whenNotSpeaking(maxMs: number) {
  return new Promise<void>((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(done, maxMs);
    function done() {
      clearTimeout(timer);
      unsubscribe();
      setTimeout(resolve, AUDIO_DRAIN_MS);
    }
    if (useRealtimeVoiceStore.getState().activity !== "speaking") return done();
    unsubscribe = useRealtimeVoiceStore.subscribe((state) => {
      if (state.activity !== "speaking") done();
    });
  });
}

/** A voice saved for an earlier voice list falls back to the default. */
export function resolveVoiceChatVoice(saved: string): RealtimeVoiceName {
  return isRealtimeVoiceName(saved) ? saved : DEFAULT_REALTIME_VOICE;
}
const GOODBYE_WAIT_MS = 8000;
const AUDIO_DRAIN_MS = 400;
const HANG_UP_RETRY_MS = 3000;
const FADE_MS = 180;
const FADE_STEPS = 12;
const isCloudSpeechError = Schema.is(CloudSpeechError);

interface RealtimeVoiceState {
  readonly status: "idle" | "connecting" | "live";
  readonly threadRef: ScopedThreadRef | null;
  readonly threadKey: string | null;
  /** The latest thing each side said. */
  readonly heard: RealtimeVoiceCaption | null;
  readonly spoken: RealtimeVoiceCaption | null;
  readonly activity: RealtimeVoiceActivity;
  readonly requests: ReadonlyArray<RealtimeVoiceRequest>;
  /** What the user is after, summarized as the call goes. */
  readonly goals: ReadonlyArray<VoiceGoal>;
  readonly muted: boolean;
}

const IDLE: RealtimeVoiceState = {
  status: "idle",
  threadRef: null,
  threadKey: null,
  heard: null,
  spoken: null,
  activity: "idle",
  requests: [],
  goals: [],
  muted: false,
};

/** The one live voice call this window can hold, and the thread it belongs to. */
export const useRealtimeVoiceStore = create<RealtimeVoiceState>(() => IDLE);

let endCurrentCall: (() => void) | null = null;
let setMicrophoneEnabled: ((enabled: boolean) => void) | null = null;

export function stopRealtimeVoice() {
  endCurrentCall?.();
}

/** Stops or resumes sending the microphone. The call stays open and can still be heard. */
export function toggleRealtimeVoiceMute() {
  if (setMicrophoneEnabled === null) return;
  const muted = !useRealtimeVoiceStore.getState().muted;
  setMicrophoneEnabled(!muted);
  useRealtimeVoiceStore.setState({ muted });
}

function readThread(threadRef: ScopedThreadRef) {
  return appAtomRegistry.get(environmentThreadDetails.threadAtom(threadRef))?.projection ?? null;
}

function snapshot(threadRef: ScopedThreadRef): RealtimeVoiceThreadSnapshot {
  const projection = readThread(threadRef);
  if (projection === null) return { working: false, needsUser: false, messages: [] };
  return {
    working: threadRuntimeIsActive(deriveThreadStructureRuntime(projection)),
    needsUser: projection.runtimeRequests.some((request) => request.status === "pending"),
    messages: projection.messages.slice(-RECENT_MESSAGES).flatMap((message) =>
      message.role === "system" || message.notification !== undefined
        ? []
        : [
            {
              id: message.id,
              role: message.role,
              text: message.text,
              streaming: message.streaming,
            },
          ],
    ),
  };
}

function openingContext(threadRef: ScopedThreadRef) {
  const projection = readThread(threadRef);
  if (projection === null) return "";
  const latest = projection.messages.findLast(
    (message) => message.role === "assistant" && !message.streaming && message.text.trim(),
  );
  return [
    `This call is about the thread "${projection.thread.title}".`,
    latest ? `Your latest message in it:\n${latest.text.trim().slice(0, CONTEXT_MAX_CHARS)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, CONTEXT_MAX_CHARS + 500);
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

  let ended = false;
  const cleanup: Array<() => void> = [];
  let released = false;
  /** Releases `release` with the call, or at once if the call has already been released. */
  const own = (release: () => void) => {
    if (released) release();
    else cleanup.push(release);
  };
  /** Lowers the call's volume to silence and says how long that takes, in milliseconds. */
  let fadeOut = () => 0;
  const end = () => {
    if (ended) return;
    ended = true;
    endCurrentCall = null;
    setMicrophoneEnabled = null;
    // A call that never connected has nothing to say goodbye to.
    if (useRealtimeVoiceStore.getState().status === "live") playCallEndSound();
    useRealtimeVoiceStore.setState(IDLE);
    // Cutting playback mid-sample clicks, so the voice fades before the call closes.
    setTimeout(() => {
      released = true;
      for (const release of cleanup.toReversed()) release();
    }, fadeOut());
  };
  endCurrentCall = end;
  useRealtimeVoiceStore.setState({
    ...IDLE,
    status: "connecting",
    threadRef,
    threadKey: scopedThreadKey(threadRef),
  });

  try {
    const microphoneId = getClientSettings().voiceMicrophone;
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
      },
    });
    own(() => media.getTracks().forEach((track) => track.stop()));
    if (ended) return;
    setMicrophoneEnabled = (enabled) => {
      for (const track of media.getAudioTracks()) track.enabled = enabled;
    };

    const peer = new RTCPeerConnection();
    own(() => peer.close());
    const speaker = new Audio();
    speaker.autoplay = true;
    own(() => {
      speaker.srcObject = null;
    });
    // Stepping the element's volume keeps the browser's echo cancellation, which Web Audio routing can lose.
    fadeOut = () => {
      for (const track of media.getAudioTracks()) track.enabled = false;
      const start = speaker.volume;
      let step = 0;
      const timer = setInterval(() => {
        step += 1;
        const remaining = 1 - step / FADE_STEPS;
        speaker.volume = Math.max(0, start * remaining * remaining);
        if (step >= FADE_STEPS) clearInterval(timer);
      }, FADE_MS / FADE_STEPS);
      own(() => clearInterval(timer));
      return FADE_MS + 20;
    };
    peer.ontrack = (event) => {
      speaker.srcObject = event.streams[0] ?? null;
    };
    for (const track of media.getAudioTracks()) peer.addTrack(track, media);
    const channel = peer.createDataChannel(REALTIME_VOICE_DATA_CHANNEL);

    const turn = async (messageId: string, text: string, steer: boolean) => {
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
    };
    const requestStatuses = new Map<string, RealtimeVoiceRequest["status"]>();
    // Updates run one at a time, in order, so a slow summary cannot overwrite a newer one.
    let goalUpdates = Promise.resolve();
    const trackGoals = (update: VoiceGoalUpdate) => {
      goalUpdates = goalUpdates.then(async () => {
        if (ended) return;
        const goals = useRealtimeVoiceStore.getState().goals;
        const next = await runEnvironmentSpeech(updateVoiceGoals(prepared, goals, update)).then(
          (result) => result.goals,
          () => fallbackVoiceGoals(goals, update),
        );
        if (!ended) useRealtimeVoiceStore.setState({ goals: next });
      });
    };
    const conversation = new RealtimeVoiceConversation(
      {
        send: (event) => {
          if (channel.readyState === "open") channel.send(JSON.stringify(event));
        },
        newMessageId,
        dispatch: turn,
        onCaption: (caption) => {
          if (ended) return;
          useRealtimeVoiceStore.setState(
            caption.role === "user" ? { heard: caption } : { spoken: caption },
          );
        },
        onRequests: (requests) => {
          if (ended) return;
          useRealtimeVoiceStore.setState({ requests });
          // Each new request, and each ending, is one event for the goal summary.
          for (const request of requests) {
            const before = requestStatuses.get(request.id);
            requestStatuses.set(request.id, request.status);
            if (before === undefined) trackGoals({ request: request.prompt });
            if (request.status !== "working" && before !== request.status)
              trackGoals({
                request: request.prompt,
                outcome: request.status === "stopped" ? "stopped" : request.status,
                ...(request.result === undefined ? {} : { result: request.result }),
              });
          }
        },
        onActivity: (activity) => {
          if (!ended) useRealtimeVoiceStore.setState({ activity });
        },
      },
      snapshot(threadRef),
    );

    // An agent can hang up the call with a tool. The environment answers one open question at a
    // time, so ask again until the call ends.
    const isOver = () => ended;
    const watching = new AbortController();
    own(() => watching.abort());
    const watchForHangUp = () => {
      void (async () => {
        // `end` flips `ended` from another closure, so read it through a function.
        while (!isOver()) {
          try {
            const hangUp = await runEnvironmentSpeech(
              waitForVoiceCallHangUp(prepared, threadRef.threadId),
              { signal: watching.signal },
            );
            if (hangUp && !isOver()) {
              // Let a goodbye the voice model is saying finish first.
              await whenNotSpeaking(GOODBYE_WAIT_MS);
              end();
            }
          } catch {
            if (isOver()) return;
            await new Promise((resolve) => setTimeout(resolve, HANG_UP_RETRY_MS));
          }
        }
      })();
    };

    channel.addEventListener("open", () => {
      if (ended) return;
      // Structure changes only: streamed text arrives several times a second and is read when it settles.
      own(
        subscribeAtomChanges(environmentThreadDetails.quietThreadAtom(threadRef), () =>
          conversation.threadChanged(snapshot(threadRef)),
        ),
      );
      conversation.threadChanged(snapshot(threadRef));
      useRealtimeVoiceStore.setState({ status: "live" });
      playCallStartSound();
      watchForHangUp();
    });
    channel.addEventListener("message", (event) => {
      try {
        conversation.handleEvent(JSON.parse(String(event.data)));
      } catch {
        // A frame that is not JSON carries nothing this call acts on.
      }
    });
    const lost = () => {
      if (ended) return;
      end();
      toastManager.add({
        type: "warning",
        title: "Voice chat ended",
        description: "The call was disconnected.",
      });
    };
    channel.addEventListener("close", lost);
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") lost();
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const answer = await runEnvironmentSpeech(
      startRealtimeVoiceCall(
        prepared,
        offer.sdp ?? "",
        resolveVoiceChatVoice(getClientSettings().voiceChatVoice),
        openingContext(threadRef),
      ),
    );
    if (ended) return;
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (cause) {
    if (ended) return;
    end();
    toastManager.add({
      type: "error",
      title: "Voice chat could not start",
      description: failureMessage(cause),
    });
  }
}
