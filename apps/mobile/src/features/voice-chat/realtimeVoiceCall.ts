import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
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
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_REALTIME_VOICE,
  type EnvironmentId,
  MessageId,
  type ScopedThreadRef,
  type VoiceGoal,
  type VoiceGoalUpdate,
} from "@t3tools/contracts";
import { REALTIME_VOICE_DATA_CHANNEL } from "@t3tools/shared/realtimeVoice";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { NativeModules, Platform } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession, sessionHasScope } from "../../state/session";
import {
  environmentThreadDetails,
  environmentThreads,
  threadEnvironment,
} from "../../state/threads";
import { runSpeech } from "../voice-input/voiceDestination";

const KEEP_AWAKE_TAG = "t3-voice-chat";
const FADE_MS = 180;
const FADE_STEPS = 12;
const isCloudSpeechError = Schema.is(CloudSpeechError);

/** Builds made before voice chat do not carry the WebRTC module. */
export const hasRealtimeVoice = Platform.OS !== "web" && NativeModules.WebRTCModule != null;

export interface VoiceChatState extends RealtimeVoiceCallState {
  readonly threadRef: ScopedThreadRef | null;
  readonly threadKey: string | null;
}

const IDLE: VoiceChatState = { ...IDLE_REALTIME_VOICE_CALL, threadRef: null, threadKey: null };

/** The one live voice call the app can hold, and the thread it belongs to. */
export const voiceChatAtom = Atom.make<VoiceChatState>(IDLE).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:voice-chat"),
);

export const useVoiceChat = () => useAtomValue(voiceChatAtom);

/** The environment's connection when it can hold a voice call, otherwise null. */
export const voiceChatConnectionAtom = Atom.family((id: EnvironmentId) =>
  Atom.make((get) => {
    const environment = get(environmentPresentations.presentationAtom(id));
    if (
      !hasRealtimeVoice ||
      environment?.connection.phase !== "connected" ||
      !environment.serverConfig?.environment.capabilities.realtimeVoice ||
      !sessionHasScope(get(environmentSession.sessionStateAtom(id)), AuthOrchestrationOperateScope)
    )
      return null;
    return Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(id)));
  }),
);

let currentCall: RealtimeVoiceCall | null = null;

export function stopVoiceChat() {
  currentCall?.end();
}

export function toggleVoiceChatMute() {
  currentCall?.toggleMute();
}

function readPreferences() {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) ? preferences.value : null;
}

/** The call sends audio off this device, so the first one says where it goes. */
function disclosed() {
  if (readPreferences()?.voiceChatDisclosed) return Promise.resolve(true);
  return new Promise<boolean>((resolve) =>
    Dialog.confirm({
      title: "Start voice chat?",
      message:
        "Voice chat uses your ChatGPT account. Your audio and this thread are sent to OpenAI during the call.",
      confirmText: "Start",
      onConfirm: () => {
        appAtomRegistry.set(updateMobilePreferencesAtom, { voiceChatDisclosed: true });
        resolve(true);
      },
      onCancel: () => resolve(false),
    }),
  );
}

function failureMessage(cause: unknown) {
  if (isCloudSpeechError(cause)) return cause.message;
  if (cause instanceof Error && cause.name === "NotAllowedError")
    return "Allow microphone access in Settings to start a voice chat.";
  return "The voice chat could not be started. Try again.";
}

function readThread(threadRef: ScopedThreadRef) {
  return appAtomRegistry.get(environmentThreadDetails.threadAtom(threadRef))?.projection ?? null;
}

/** The phone's microphone and speaker on one WebRTC call. iOS routes it to the speaker, not the earpiece. */
async function openNativeTransport(onAudioTaken: () => void): Promise<RealtimeVoiceTransport> {
  // Recording mode is play-and-record with the loudspeaker as the default route.
  const audio = acquireAudioSession("recording", onAudioTaken);
  const releaseAwake = (() => {
    const activation = activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    void activation.catch(() => {});
    return () => void activation.then(() => deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => {});
  })();
  const released: Array<() => void> = [
    releaseAwake,
    () => void releaseAudioSession(audio).catch(() => {}),
  ];
  const release = () => {
    for (const step of released.splice(0).reverse()) step();
  };
  try {
    await activateAudioSession(audio);
    const { mediaDevices, RTCPeerConnection } = await import("react-native-webrtc");
    // The platform's voice processing cancels echo and noise for WebRTC audio.
    const media = await mediaDevices.getUserMedia({ audio: true, video: false });
    released.push(() => media.getTracks().forEach((track) => track.stop()));
    const setMicrophoneEnabled = (enabled: boolean) => {
      for (const track of media.getAudioTracks()) track.enabled = enabled;
    };
    const peer = new RTCPeerConnection();
    released.push(() => peer.close());
    let speaker: { _setVolume(volume: number): void } | null = null;
    peer.addEventListener("track", (event) => {
      if (event.track?.kind === "audio") speaker = event.track;
    });
    for (const track of media.getAudioTracks()) peer.addTrack(track, media);
    const channel = peer.createDataChannel(REALTIME_VOICE_DATA_CHANNEL);
    let fade: ReturnType<typeof setInterval> | undefined;
    released.push(() => clearInterval(fade));
    return {
      createOffer: async () => {
        const offer = await peer.createOffer({});
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
      fadeOut: () => {
        const track = speaker;
        if (track === null) return 0;
        let step = 0;
        fade = setInterval(() => {
          step += 1;
          const remaining = 1 - step / FADE_STEPS;
          track._setVolume(Math.max(0, remaining * remaining));
          if (step >= FADE_STEPS) clearInterval(fade);
        }, FADE_MS / FADE_STEPS);
        return FADE_MS + 20;
      },
      close: release,
    };
  } catch (cause) {
    release();
    throw cause;
  }
}

function startTurn(threadRef: ScopedThreadRef) {
  return async (messageId: string, text: string, steer: boolean) => {
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
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          dispatchMode: steer ? "steer" : "auto",
        },
      },
      { label: "voice chat request", reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  };
}

function callDependencies(prepared: PreparedConnection, threadRef: ScopedThreadRef) {
  return {
    answerOffer: (offer: string) =>
      runSpeech(
        startRealtimeVoiceCall(
          prepared,
          offer,
          readPreferences()?.voiceChatVoice ?? DEFAULT_REALTIME_VOICE,
          realtimeVoiceOpeningContext(readThread(threadRef)),
        ),
      ),
    dispatch: startTurn(threadRef),
    newMessageId: uuidv4,
    readThread: () => realtimeVoiceThreadSnapshot(readThread(threadRef)),
    // Structure changes only: streamed text arrives several times a second and is read when it settles.
    subscribeThread: (onChange: () => void) =>
      appAtomRegistry.subscribe(environmentThreadDetails.quietThreadAtom(threadRef), onChange),
    updateGoals: (goals: ReadonlyArray<VoiceGoal>, update: VoiceGoalUpdate) =>
      runSpeech(updateVoiceGoals(prepared, goals, update)).then((result) => result.goals),
    waitForHangUp: (signal: AbortSignal) =>
      runSpeech(waitForVoiceCallHangUp(prepared, threadRef.threadId), signal),
  };
}

/** Starts a live voice call about `threadRef`, ending any call already open. */
export async function startVoiceChat(threadRef: ScopedThreadRef) {
  stopVoiceChat();
  const prepared = appAtomRegistry.get(voiceChatConnectionAtom(threadRef.environmentId));
  if (prepared === null) {
    Dialog.alert("Voice chat unavailable", "This environment cannot hold a voice chat.");
    return;
  }
  if (!(await disclosed())) return;

  const threadKey = scopedThreadKey(threadRef.environmentId, threadRef.threadId);
  // The call outlives the thread's screen, so it keeps the thread loaded itself.
  const releaseThread = appAtomRegistry.mount(
    environmentThreads.stateAtom(threadRef.environmentId, threadRef.threadId),
  );
  const call: RealtimeVoiceCall = new RealtimeVoiceCall({
    ...callDependencies(prepared, threadRef),
    // Another recording, such as dictation, takes the microphone and ends the call.
    openTransport: () => openNativeTransport(() => call.end()),
    onState: (state) => {
      if (currentCall !== call) return;
      if (state.status === "idle") {
        currentCall = null;
        releaseThread();
        appAtomRegistry.set(voiceChatAtom, IDLE);
        return;
      }
      appAtomRegistry.set(voiceChatAtom, { ...state, threadRef, threadKey });
    },
    onLost: () => Dialog.alert("Voice chat ended", "The call was disconnected."),
    onFailed: (cause) => Dialog.alert("Voice chat could not start", failureMessage(cause)),
  });
  currentCall = call;
  await call.start();
}
