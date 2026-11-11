import {
  REALTIME_VOICE_FAILED_TEXT,
  REALTIME_VOICE_NEEDS_USER_TEXT,
  REALTIME_VOICE_STEERED_TEXT,
  realtimeVoiceResultText,
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
  readonly onCaption?: (caption: RealtimeVoiceCaption) => void;
  /** The call's recent requests, newest last, whenever one is added or changes status. */
  readonly onRequests?: (requests: ReadonlyArray<RealtimeVoiceRequest>) => void;
  readonly onActivity?: (activity: RealtimeVoiceActivity) => void;
  readonly onError?: (message: string) => void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** The text parts of a delegation item, which carry the user's request. */
function delegationText(item: Record<string, unknown>) {
  const content = item.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const value = record(part);
      return value?.type === "input_text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join(" ")
    .trim();
}

/**
 * One live voice call bound to one thread, on the ChatGPT voice route Codex uses. The voice model
 * speaks with the user and delegates work; this hands each delegation to the thread's agent and
 * reports what the agent did back to it. It owns no audio and no socket.
 */
export class RealtimeVoiceConversation {
  readonly #deps: RealtimeVoiceConversationDependencies;
  /** Messages already reported to the voice model, or older than the call. */
  readonly #known = new Set<string>();
  /** Messages this call sent, so they are not reported back as typed text. */
  readonly #sent = new Set<string>();
  /** Sent messages the thread has not shown yet. The agent counts as working until it does. */
  readonly #unconfirmed = new Set<string>();
  #threadWorking: boolean;
  #needsUserAnnounced: boolean;
  /** The delegation the current work reports to; its result is spoken when the work ends. */
  #delegation: string | null = null;
  /** The agent's latest finished message since the work last ended. */
  #result: string | null = null;
  #requests: ReadonlyArray<RealtimeVoiceRequest> = [];
  readonly #captions = { user: "", assistant: "" };
  readonly #turnRoles = new Map<string, "user" | "assistant">();

  constructor(deps: RealtimeVoiceConversationDependencies, thread: RealtimeVoiceThreadSnapshot) {
    this.#deps = deps;
    this.#threadWorking = thread.working;
    this.#needsUserAnnounced = thread.needsUser;
    for (const message of thread.messages) this.#known.add(message.id);
  }

  get working() {
    return this.#threadWorking || this.#unconfirmed.size > 0;
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
        // Progress stays quiet; the last message before the work ends is spoken as the result.
        if (this.#result !== null) this.#report(this.#result, "commentary");
        this.#result = message.text;
      } else {
        this.#context(`The user typed in the app: ${message.text.trim()}`, "commentary");
      }
    }
    this.#threadWorking = thread.working;
    if (thread.needsUser && !this.#needsUserAnnounced)
      this.#report(REALTIME_VOICE_NEEDS_USER_TEXT, "speakable");
    this.#needsUserAnnounced = thread.needsUser;
    this.#settle();
  }

  /** Takes one decoded event from the call's data channel. */
  handleEvent(event: unknown) {
    const value = record(event);
    if (value === null) return;
    switch (value.type) {
      case "delegation.created": {
        const item = record(value.item);
        if (item === null || typeof item.id !== "string") return;
        if (item.target !== undefined && item.target !== "client") return;
        this.#delegate(item.id, delegationText(item));
        return;
      }
      case "turn.created": {
        const turn = record(value.turn);
        const role = turn?.role;
        if ((role !== "user" && role !== "assistant") || typeof turn?.id !== "string") return;
        this.#turnRoles.set(turn.id, role);
        this.#captions[role] = typeof turn.transcript === "string" ? turn.transcript : "";
        this.#deps.onActivity?.(role === "user" ? "listening" : "speaking");
        if (this.#captions[role].trim())
          this.#deps.onCaption?.({ role, text: this.#captions[role].trim(), live: true });
        return;
      }
      case "turn.delta": {
        const role =
          typeof value.turn_id === "string" ? this.#turnRoles.get(value.turn_id) : undefined;
        if (role === undefined || typeof value.delta !== "string") return;
        this.#captions[role] += value.delta;
        this.#deps.onCaption?.({ role, text: this.#captions[role].trim(), live: true });
        return;
      }
      case "turn.done": {
        const turn = record(value.turn);
        const role = turn?.role;
        if (role !== "user" && role !== "assistant") return;
        const text = typeof turn?.transcript === "string" ? turn.transcript.trim() : "";
        if (typeof turn?.id === "string") this.#turnRoles.delete(turn.id);
        if (text) this.#deps.onCaption?.({ role, text, live: false });
        this.#deps.onActivity?.("idle");
        return;
      }
      case "error": {
        const message = record(value.error)?.message;
        if (typeof message === "string") this.#deps.onError?.(message);
        return;
      }
    }
  }

  #delegate(itemId: string, prompt: string) {
    if (!prompt) {
      this.#append(itemId, REALTIME_VOICE_FAILED_TEXT, "speakable");
      return;
    }
    const steer = this.working;
    const messageId = this.#deps.newMessageId();
    this.#sent.add(messageId);
    this.#unconfirmed.add(messageId);
    if (!steer) {
      this.#delegation = itemId;
      this.#result = null;
    }
    this.#setRequests([
      ...this.#requests.slice(1 - MAX_REQUESTS),
      { id: messageId, prompt, status: "working" },
    ]);
    this.#deps.dispatch(messageId, prompt, steer).then(
      () => {
        if (steer) this.#append(itemId, REALTIME_VOICE_STEERED_TEXT, "commentary");
      },
      () => {
        this.#unconfirmed.delete(messageId);
        this.#setRequests(
          this.#requests.map((request) =>
            request.id === messageId ? { ...request, status: "failed" } : request,
          ),
        );
        if (this.#delegation === itemId) this.#delegation = null;
        this.#append(itemId, REALTIME_VOICE_FAILED_TEXT, "speakable");
        this.#settle();
      },
    );
  }

  /** Once the agent is idle, marks the requests done and has the result spoken. */
  #settle() {
    if (this.working) return;
    if (this.#requests.some((request) => request.status === "working"))
      this.#setRequests(
        this.#requests.map((request) =>
          request.status === "working" ? { ...request, status: "done" } : request,
        ),
      );
    if (this.#result !== null) this.#report(this.#result, "speakable");
    this.#result = null;
    this.#delegation = null;
  }

  /** Reports work output to the delegation it answers, or to the call when nothing asked. */
  #report(text: string, channel: "commentary" | "speakable") {
    const body = realtimeVoiceResultText(text);
    if (this.#delegation !== null) this.#append(this.#delegation, body, channel);
    else this.#context(body, channel);
  }

  #append(delegationItemId: string, text: string, channel: "commentary" | "speakable") {
    this.#deps.send({
      type: "delegation.context.append",
      delegation_item_id: delegationItemId,
      channel,
      content: [{ type: "input_text", text }],
    });
  }

  #context(text: string, channel: "commentary" | "speakable") {
    this.#deps.send({
      type: "session.context.append",
      channel,
      content: [{ type: "input_text", text }],
    });
  }

  #setRequests(requests: ReadonlyArray<RealtimeVoiceRequest>) {
    this.#requests = requests;
    this.#deps.onRequests?.(requests);
  }
}
