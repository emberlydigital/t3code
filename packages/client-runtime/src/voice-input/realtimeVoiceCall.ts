// @effect-diagnostics globalTimers:off - A live call paces audio fades and retries outside an Effect runtime.
import type {
  OrchestrationV2ThreadProjection,
  VoiceGoal,
  VoiceGoalUpdate,
} from "@t3tools/contracts";
import { fallbackVoiceGoals } from "@t3tools/shared/voiceGoals";

import { threadRuntimeIsActive } from "../state/models.ts";
import { deriveThreadStructureRuntime } from "../state/threadExecution.ts";
import {
  RealtimeVoiceConversation,
  type RealtimeVoiceActivity,
  type RealtimeVoiceCaption,
  type RealtimeVoiceRequest,
  type RealtimeVoiceThreadSnapshot,
} from "./realtimeVoice.ts";

/** One call's audio and control channel, as each platform's WebRTC provides them. */
export interface RealtimeVoiceTransport {
  /** Creates the local offer once the microphone and the data channel exist. */
  readonly createOffer: () => Promise<string>;
  readonly acceptAnswer: (sdp: string) => Promise<void>;
  /** Writes one text frame to the data channel; frames before it opens are dropped. */
  readonly send: (data: string) => void;
  readonly onOpen: (listener: () => void) => void;
  readonly onMessage: (listener: (data: string) => void) => void;
  /** The channel or the connection went away without the call being ended. */
  readonly onLost: (listener: () => void) => void;
  readonly setMicrophoneEnabled: (enabled: boolean) => void;
  /** Lowers playback to silence and returns how long that takes, in milliseconds. */
  readonly fadeOut: () => number;
  readonly close: () => void;
}

export type RealtimeVoiceCallStatus = "idle" | "connecting" | "live";

export interface RealtimeVoiceCallState {
  readonly status: RealtimeVoiceCallStatus;
  /** The latest thing each side said. */
  readonly heard: RealtimeVoiceCaption | null;
  readonly spoken: RealtimeVoiceCaption | null;
  readonly activity: RealtimeVoiceActivity;
  readonly requests: ReadonlyArray<RealtimeVoiceRequest>;
  /** What the user is after, summarized as the call goes. */
  readonly goals: ReadonlyArray<VoiceGoal>;
  readonly muted: boolean;
}

export const IDLE_REALTIME_VOICE_CALL: RealtimeVoiceCallState = {
  status: "idle",
  heard: null,
  spoken: null,
  activity: "idle",
  requests: [],
  goals: [],
  muted: false,
};

export interface RealtimeVoiceCallDependencies {
  /** Opens the microphone, the peer connection and its data channel. */
  readonly openTransport: () => Promise<RealtimeVoiceTransport>;
  /** Exchanges the offer for the environment's answer. */
  readonly answerOffer: (offer: string) => Promise<string>;
  /** Sends `prompt` to the thread as `messageId`; `steer` when the agent is working. */
  readonly dispatch: (messageId: string, prompt: string, steer: boolean) => Promise<void>;
  readonly newMessageId: () => string;
  readonly readThread: () => RealtimeVoiceThreadSnapshot;
  /** Calls back when the thread's structure changes; returns how to stop. */
  readonly subscribeThread: (onChange: () => void) => () => void;
  readonly updateGoals: (
    goals: ReadonlyArray<VoiceGoal>,
    update: VoiceGoalUpdate,
  ) => Promise<ReadonlyArray<VoiceGoal>>;
  /** Resolves true when an agent asks to hang up, false when it is time to ask again. */
  readonly waitForHangUp: (signal: AbortSignal) => Promise<boolean>;
  readonly onState: (state: RealtimeVoiceCallState) => void;
  readonly onLost?: () => void;
  readonly onFailed?: (cause: unknown) => void;
  readonly playStartSound?: () => void;
  readonly playEndSound?: () => void;
}

/** How many of the thread's newest messages each change re-reads. */
const RECENT_MESSAGES = 40;
const CONTEXT_MAX_CHARS = 3000;

/** What the voice model is told about the thread as it changes. */
export function realtimeVoiceThreadSnapshot(
  projection: OrchestrationV2ThreadProjection | null,
): RealtimeVoiceThreadSnapshot {
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

/** The thread's state as the call opens, carried in the session's instructions. */
export function realtimeVoiceOpeningContext(projection: OrchestrationV2ThreadProjection | null) {
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

/** Wait for a goodbye the voice model is saying before hanging up for an agent. */
const GOODBYE_WAIT_MS = 8000;
/** The last syllable is still in the playback buffer when speech is reported done. */
const AUDIO_DRAIN_MS = 400;
const HANG_UP_RETRY_MS = 3000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One live voice call about one thread, with the platform's audio plugged in. It owns the call's
 * lifecycle, the conversation with the voice model, the goal summary, mute, and an agent's
 * request to hang up, so web and mobile behave the same.
 */
export class RealtimeVoiceCall {
  readonly #deps: RealtimeVoiceCallDependencies;
  #state: RealtimeVoiceCallState = { ...IDLE_REALTIME_VOICE_CALL, status: "connecting" };
  #transport: RealtimeVoiceTransport | null = null;
  #ended = false;
  readonly #cleanup: Array<() => void> = [];
  readonly #watching = new AbortController();
  #goalUpdates = Promise.resolve();
  readonly #requestStatuses = new Map<string, RealtimeVoiceRequest["status"]>();
  #onQuiet: (() => void) | null = null;

  constructor(deps: RealtimeVoiceCallDependencies) {
    this.#deps = deps;
  }

  get state() {
    return this.#state;
  }

  get ended() {
    return this.#ended;
  }

  /** Connects the call. Failures end it and are reported through `onFailed`. */
  async start() {
    this.#setState({});
    try {
      const transport = await this.#deps.openTransport();
      if (this.#ended) {
        transport.close();
        return;
      }
      this.#transport = transport;
      const conversation = new RealtimeVoiceConversation(
        {
          send: (event) => transport.send(JSON.stringify(event)),
          newMessageId: this.#deps.newMessageId,
          dispatch: this.#deps.dispatch,
          onCaption: (caption) =>
            this.#setState(caption.role === "user" ? { heard: caption } : { spoken: caption }),
          onRequests: (requests) => this.#requestsChanged(requests),
          onActivity: (activity) => this.#setState({ activity }),
        },
        this.#deps.readThread(),
      );
      transport.onMessage((data) => {
        if (this.#ended) return;
        try {
          conversation.handleEvent(JSON.parse(data));
        } catch {
          // A frame that is not JSON carries nothing this call acts on.
        }
      });
      transport.onOpen(() => {
        if (this.#ended) return;
        this.#cleanup.push(
          this.#deps.subscribeThread(() => conversation.threadChanged(this.#deps.readThread())),
        );
        conversation.threadChanged(this.#deps.readThread());
        this.#setState({ status: "live" });
        this.#deps.playStartSound?.();
        void this.#watchForHangUp();
      });
      transport.onLost(() => {
        if (this.#ended) return;
        this.end();
        this.#deps.onLost?.();
      });
      const answer = await this.#deps.answerOffer(await transport.createOffer());
      if (this.#ended) return;
      await transport.acceptAnswer(answer);
    } catch (cause) {
      if (this.#ended) return;
      this.end();
      this.#deps.onFailed?.(cause);
    }
  }

  /** Hangs up. The agent keeps working; only the call ends. */
  end() {
    if (this.#ended) return;
    this.#ended = true;
    // A call that never connected has nothing to say goodbye to.
    if (this.#state.status === "live") this.#deps.playEndSound?.();
    this.#watching.abort();
    for (const release of [...this.#cleanup].reverse()) release();
    this.#setState({ ...IDLE_REALTIME_VOICE_CALL });
    const transport = this.#transport;
    if (transport === null) return;
    // Cutting playback mid-sample clicks, so the voice fades before the call closes.
    transport.setMicrophoneEnabled(false);
    setTimeout(() => transport.close(), transport.fadeOut());
  }

  /** Stops or resumes sending the microphone. The call stays open and can still be heard. */
  toggleMute() {
    if (this.#ended || this.#transport === null) return;
    const muted = !this.#state.muted;
    this.#transport.setMicrophoneEnabled(!muted);
    this.#setState({ muted });
  }

  #setState(patch: Partial<RealtimeVoiceCallState>) {
    if (this.#ended && patch.status !== "idle") return;
    this.#state = { ...this.#state, ...patch };
    this.#deps.onState(this.#state);
    if (this.#state.activity !== "speaking") this.#onQuiet?.();
  }

  /** Each new request, and each ending, is one event for the goal summary. */
  #requestsChanged(requests: ReadonlyArray<RealtimeVoiceRequest>) {
    this.#setState({ requests });
    for (const request of requests) {
      const before = this.#requestStatuses.get(request.id);
      this.#requestStatuses.set(request.id, request.status);
      if (before === undefined) this.#trackGoals({ request: request.prompt });
      if (request.status !== "working" && before !== request.status)
        this.#trackGoals({
          request: request.prompt,
          outcome: request.status,
          ...(request.result === undefined ? {} : { result: request.result }),
        });
    }
  }

  /** Updates run one at a time, in order, so a slow summary cannot overwrite a newer one. */
  #trackGoals(update: VoiceGoalUpdate) {
    this.#goalUpdates = this.#goalUpdates.then(async () => {
      if (this.#ended) return;
      const goals = this.#state.goals;
      const next = await this.#deps
        .updateGoals(goals, update)
        .catch(() => fallbackVoiceGoals(goals, update));
      this.#setState({ goals: next });
    });
  }

  /** An agent can hang up with a tool; the environment answers one open question at a time. */
  async #watchForHangUp() {
    while (!this.#ended) {
      try {
        const hangUp = await this.#deps.waitForHangUp(this.#watching.signal);
        if (hangUp && !this.#ended) {
          await this.#whenNotSpeaking();
          this.end();
        }
      } catch {
        if (this.#ended) return;
        await delay(HANG_UP_RETRY_MS);
      }
    }
  }

  #whenNotSpeaking() {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#onQuiet = null;
        setTimeout(resolve, AUDIO_DRAIN_MS);
      };
      const timer = setTimeout(done, GOODBYE_WAIT_MS);
      if (this.#state.activity === "speaking") this.#onQuiet = done;
      else done();
    });
  }
}
