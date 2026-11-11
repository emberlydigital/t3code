import {
  REALTIME_VOICE_BACKEND_PREFIX,
  REALTIME_VOICE_DELEGATE_TOOL,
  REALTIME_VOICE_FAILED_OUTPUT,
  REALTIME_VOICE_FINISHED_OUTPUT,
  REALTIME_VOICE_INTERRUPTED_OUTPUT,
  REALTIME_VOICE_INTERRUPT_TOOL,
  REALTIME_VOICE_NEEDS_USER_TEXT,
  REALTIME_VOICE_NOTHING_RUNNING_OUTPUT,
  REALTIME_VOICE_SILENT_TOOL,
  REALTIME_VOICE_STEERED_OUTPUT,
  REALTIME_VOICE_USER_PREFIX,
  realtimeVoiceBackendText,
} from "@t3tools/shared/realtimeVoice";

export interface RealtimeVoiceThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
}

/** What the conversation needs to know about its thread, read again on every change. */
export interface RealtimeVoiceThreadSnapshot {
  readonly working: boolean;
  /** An approval or question is waiting for the user in the app. */
  readonly needsUser: boolean;
  /** The thread's newest messages. Older ones may be left out. */
  readonly messages: ReadonlyArray<RealtimeVoiceThreadMessage>;
}

export interface RealtimeVoiceCaption {
  readonly role: "user" | "assistant";
  readonly text: string;
  /** Still being spoken, so the text can grow. */
  readonly live: boolean;
}

/** Something the user asked for by voice that went to the agent. */
export interface RealtimeVoiceRequest {
  readonly id: string;
  readonly prompt: string;
  readonly status: "working" | "done" | "stopped" | "failed";
}

/** Who is talking: the user (`listening`), the voice model (`speaking`), or nobody. */
export type RealtimeVoiceActivity = "idle" | "listening" | "speaking";

const MAX_REQUESTS = 6;

export interface RealtimeVoiceConversationDependencies {
  /** Writes one event to the call's data channel. */
  readonly send: (event: Record<string, unknown>) => void;
  readonly newMessageId: () => string;
  /** Sends `prompt` to the thread as the message `messageId`; `steer` when the agent is working. */
  readonly dispatch: (messageId: string, prompt: string, steer: boolean) => Promise<void>;
  readonly interrupt: () => Promise<void>;
  readonly onCaption?: (caption: RealtimeVoiceCaption) => void;
  /** The call's recent requests, newest last, whenever one is added or changes status. */
  readonly onRequests?: (requests: ReadonlyArray<RealtimeVoiceRequest>) => void;
  readonly onActivity?: (activity: RealtimeVoiceActivity) => void;
  readonly onError?: (message: string) => void;
}

interface FunctionCall {
  readonly name: string;
  readonly callId: string;
  readonly arguments: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function functionCalls(response: unknown): ReadonlyArray<FunctionCall> {
  const output = record(response)?.output;
  if (!Array.isArray(output)) return [];
  return output.flatMap((entry) => {
    const item = record(entry);
    return item?.type === "function_call" &&
      typeof item.name === "string" &&
      typeof item.call_id === "string"
      ? [
          {
            name: item.name,
            callId: item.call_id,
            arguments: typeof item.arguments === "string" ? item.arguments : "",
          },
        ]
      : [];
  });
}

function delegatedPrompt(json: string) {
  try {
    const prompt = record(JSON.parse(json))?.prompt;
    if (typeof prompt !== "string") return "";
    const trimmed = prompt.trim();
    return trimmed.startsWith(REALTIME_VOICE_USER_PREFIX.trim())
      ? trimmed.slice(REALTIME_VOICE_USER_PREFIX.trim().length).trim()
      : trimmed;
  } catch {
    return "";
  }
}

/**
 * One live voice call bound to one thread. The voice model speaks with the user; this hands its
 * requests to the thread's agent and tells it what the agent did. It owns no audio and no socket.
 */
export class RealtimeVoiceConversation {
  readonly #deps: RealtimeVoiceConversationDependencies;
  /** Messages already told to the voice model, or older than the call. */
  readonly #known = new Set<string>();
  /** Messages this call sent, so they are not echoed back as typed text. */
  readonly #sent = new Set<string>();
  /** Sent messages the thread has not shown yet. The agent counts as working until it does. */
  readonly #unconfirmed = new Set<string>();
  #threadWorking: boolean;
  /** The delegate call that returns when the agent goes idle. */
  #openCall: string | null = null;
  /** Agent output arrived that the voice model has not been asked to speak about. */
  #unspoken = false;
  #needsUserAnnounced: boolean;
  #stopping = false;
  #responseActive = false;
  #responseWanted = false;
  #assistantCaption = "";
  #userCaption = { itemId: "", text: "" };
  #requests: ReadonlyArray<RealtimeVoiceRequest> = [];

  constructor(deps: RealtimeVoiceConversationDependencies, thread: RealtimeVoiceThreadSnapshot) {
    this.#deps = deps;
    this.#threadWorking = thread.working;
    this.#needsUserAnnounced = thread.needsUser;
    for (const message of thread.messages) this.#known.add(message.id);
  }

  get working() {
    return this.#threadWorking || this.#unconfirmed.size > 0;
  }

  /** Gives the voice model what the thread is about. Call once the data channel is open. */
  start(context: string) {
    if (context.trim()) this.#say(`${REALTIME_VOICE_BACKEND_PREFIX}${context.trim()}`);
  }

  threadChanged(thread: RealtimeVoiceThreadSnapshot) {
    for (const message of thread.messages) {
      if (this.#sent.has(message.id)) {
        this.#unconfirmed.delete(message.id);
        this.#known.add(message.id);
        continue;
      }
      if (message.streaming || this.#known.has(message.id)) continue;
      this.#known.add(message.id);
      if (!message.text.trim()) continue;
      if (message.role === "assistant") {
        this.#say(realtimeVoiceBackendText(message.text));
        this.#unspoken = true;
      } else {
        this.#say(`${REALTIME_VOICE_USER_PREFIX}${message.text.trim()}`);
      }
    }
    this.#threadWorking = thread.working;
    if (thread.needsUser && !this.#needsUserAnnounced) {
      this.#say(`${REALTIME_VOICE_BACKEND_PREFIX}${REALTIME_VOICE_NEEDS_USER_TEXT}`);
      this.#respond();
    }
    this.#needsUserAnnounced = thread.needsUser;
    this.#settle();
  }

  /** Takes one decoded event from the call's data channel. */
  handleEvent(event: unknown) {
    const value = record(event);
    if (value === null) return;
    switch (value.type) {
      case "response.created":
        this.#responseActive = true;
        this.#assistantCaption = "";
        return;
      case "response.done":
        this.#responseActive = false;
        for (const call of functionCalls(value.response)) this.#call(call);
        if (this.#responseWanted) this.#respond();
        return;
      case "input_audio_buffer.speech_started":
        this.#deps.onActivity?.("listening");
        this.#deps.onCaption?.({ role: "user", text: "", live: true });
        return;
      case "input_audio_buffer.speech_stopped":
        this.#deps.onActivity?.("idle");
        return;
      case "output_audio_buffer.started":
        this.#deps.onActivity?.("speaking");
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.#deps.onActivity?.("idle");
        return;
      case "conversation.item.input_audio_transcription.delta": {
        if (typeof value.delta !== "string") return;
        const itemId = typeof value.item_id === "string" ? value.item_id : "";
        this.#userCaption =
          this.#userCaption.itemId === itemId
            ? { itemId, text: this.#userCaption.text + value.delta }
            : { itemId, text: value.delta };
        this.#deps.onCaption?.({ role: "user", text: this.#userCaption.text, live: true });
        return;
      }
      case "conversation.item.input_audio_transcription.completed":
        if (typeof value.transcript === "string" && value.transcript.trim())
          this.#deps.onCaption?.({ role: "user", text: value.transcript.trim(), live: false });
        return;
      case "response.output_audio_transcript.delta":
        if (typeof value.delta !== "string") return;
        this.#assistantCaption += value.delta;
        this.#deps.onCaption?.({ role: "assistant", text: this.#assistantCaption, live: true });
        return;
      case "response.output_audio_transcript.done":
        if (typeof value.transcript === "string" && value.transcript.trim())
          this.#deps.onCaption?.({
            role: "assistant",
            text: value.transcript.trim(),
            live: false,
          });
        return;
      case "error": {
        const error = record(value.error);
        if (error?.code === "conversation_already_has_active_response") {
          this.#responseActive = true;
          this.#responseWanted = true;
          return;
        }
        if (typeof error?.message === "string") this.#deps.onError?.(error.message);
        return;
      }
    }
  }

  #call(call: FunctionCall) {
    switch (call.name) {
      case REALTIME_VOICE_DELEGATE_TOOL:
        return this.#delegate(call);
      case REALTIME_VOICE_INTERRUPT_TOOL:
        return this.#interrupt(call);
      case REALTIME_VOICE_SILENT_TOOL:
        return this.#output(call.callId, "");
      default:
        this.#output(call.callId, "Unknown tool.");
        this.#respond();
    }
  }

  #delegate(call: FunctionCall) {
    const prompt = delegatedPrompt(call.arguments);
    if (!prompt) {
      this.#output(call.callId, REALTIME_VOICE_FAILED_OUTPUT);
      this.#respond();
      return;
    }
    const steer = this.working;
    const messageId = this.#deps.newMessageId();
    this.#sent.add(messageId);
    this.#unconfirmed.add(messageId);
    if (!steer) this.#openCall = call.callId;
    this.#setRequests([
      ...this.#requests.slice(1 - MAX_REQUESTS),
      { id: messageId, prompt, status: "working" },
    ]);
    this.#deps.dispatch(messageId, prompt, steer).then(
      () => {
        if (!steer) return;
        this.#output(call.callId, REALTIME_VOICE_STEERED_OUTPUT);
        this.#respond();
      },
      () => {
        this.#unconfirmed.delete(messageId);
        this.#setRequests(
          this.#requests.map((request) =>
            request.id === messageId ? { ...request, status: "failed" } : request,
          ),
        );
        if (this.#openCall === call.callId) this.#openCall = null;
        this.#output(call.callId, REALTIME_VOICE_FAILED_OUTPUT);
        this.#respond();
        this.#settle();
      },
    );
  }

  #interrupt(call: FunctionCall) {
    if (!this.working) {
      this.#output(call.callId, REALTIME_VOICE_NOTHING_RUNNING_OUTPUT);
      this.#respond();
      return;
    }
    this.#stopping = true;
    this.#deps.interrupt().then(
      () => {
        this.#output(call.callId, REALTIME_VOICE_INTERRUPTED_OUTPUT);
        this.#respond();
      },
      () => {
        this.#stopping = false;
        this.#output(call.callId, REALTIME_VOICE_FAILED_OUTPUT);
        this.#respond();
      },
    );
  }

  /** Once the agent is idle, returns the open call and has the result spoken. */
  #settle() {
    if (this.working) return;
    const stopped = this.#stopping;
    this.#stopping = false;
    if (this.#requests.some((request) => request.status === "working"))
      this.#setRequests(
        this.#requests.map((request) =>
          request.status === "working"
            ? { ...request, status: stopped ? "stopped" : "done" }
            : request,
        ),
      );
    if (this.#openCall !== null) {
      this.#output(
        this.#openCall,
        stopped ? REALTIME_VOICE_INTERRUPTED_OUTPUT : REALTIME_VOICE_FINISHED_OUTPUT,
      );
      this.#openCall = null;
      if (!stopped) this.#respond();
    } else if (this.#unspoken && !stopped) {
      this.#respond();
    }
    this.#unspoken = false;
  }

  #setRequests(requests: ReadonlyArray<RealtimeVoiceRequest>) {
    this.#requests = requests;
    this.#deps.onRequests?.(requests);
  }

  #say(text: string) {
    this.#deps.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
  }

  #output(callId: string, output: string) {
    this.#deps.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
  }

  /** Only one response may run at a time, so a request made during one waits for it to end. */
  #respond() {
    if (this.#responseActive) {
      this.#responseWanted = true;
      return;
    }
    this.#responseWanted = false;
    this.#responseActive = true;
    this.#deps.send({ type: "response.create" });
  }
}
