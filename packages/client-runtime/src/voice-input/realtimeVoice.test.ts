import { describe, expect, it, vi } from "vite-plus/test";

import {
  RealtimeVoiceConversation,
  type RealtimeVoiceThreadMessage,
  type RealtimeVoiceThreadSnapshot,
} from "./realtimeVoice.ts";

const idle: RealtimeVoiceThreadSnapshot = { working: false, needsUser: false, messages: [] };

function thread(
  working: boolean,
  messages: ReadonlyArray<RealtimeVoiceThreadMessage> = [],
  needsUser = false,
): RealtimeVoiceThreadSnapshot {
  return { working, needsUser, messages };
}

function setup(initial = idle) {
  const events: Array<Record<string, unknown>> = [];
  const dispatch = vi.fn(async (_id: string, _prompt: string, _steer: boolean) => undefined);
  let nextId = 0;
  const view = { requests: [] as ReadonlyArray<string>, captions: [] as Array<string> };
  const conversation = new RealtimeVoiceConversation(
    {
      send: (event) => events.push(event),
      newMessageId: () => `sent-${++nextId}`,
      dispatch,
      onRequests: (requests) => {
        view.requests = requests.map((request) => `${request.prompt}: ${request.status}`);
      },
      onCaption: (caption) =>
        view.captions.push(`${caption.role}${caption.live ? "…" : ""}: ${caption.text}`),
    },
    initial,
  );
  const delegate = (id: string, text: string) =>
    conversation.handleEvent({
      type: "delegation.created",
      item: { id, type: "delegation", target: "client", content: [{ type: "input_text", text }] },
    });
  /** Sent events as short strings: `target/channel: text`. */
  const sent = () =>
    events.splice(0).map((event) => {
      const target =
        event.type === "delegation.context.append" ? String(event.delegation_item_id) : "call";
      const [content] = event.content as ReadonlyArray<{ text: string }>;
      return `${target}/${String(event.channel)}: ${content!.text}`;
    });
  return { conversation, dispatch, delegate, sent, view };
}

const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("RealtimeVoiceConversation", () => {
  it("hands a delegation to the idle agent and speaks the result when the agent goes idle", async () => {
    const { conversation, dispatch, delegate, sent, view } = setup(
      thread(false, [{ id: "old", role: "assistant", text: "Earlier answer", streaming: false }]),
    );
    delegate("item-1", "add a toggle");
    expect(dispatch).toHaveBeenCalledWith("sent-1", "add a toggle", false);
    await settled();
    // The thread has not shown the message yet, so an idle snapshot is not the end of the work.
    conversation.threadChanged(thread(false));
    expect(sent()).toEqual([]);
    const request = { id: "sent-1", role: "user", text: "add a toggle", streaming: false } as const;
    conversation.threadChanged(
      thread(true, [
        request,
        { id: "a1", role: "assistant", text: "Looking at the settings page.", streaming: false },
        { id: "a2", role: "assistant", text: "Still writing", streaming: true },
      ]),
    );
    expect(sent()).toEqual([]);
    conversation.threadChanged(
      thread(false, [
        request,
        { id: "a1", role: "assistant", text: "Looking at the settings page.", streaming: false },
        { id: "a2", role: "assistant", text: "Added it.", streaming: false },
      ]),
    );
    expect(sent()).toEqual([
      "item-1/commentary: Looking at the settings page.",
      "item-1/speakable: Added it.",
    ]);
    expect(view.requests).toEqual(["add a toggle: done"]);
  });

  it("sends everything said since the last request when the route hands over only the last piece", () => {
    const { conversation, dispatch, delegate } = setup();
    const said = (id: string, role: "user" | "assistant", transcript: string) => {
      conversation.handleEvent({ type: "turn.created", turn: { id, role, transcript: "" } });
      conversation.handleEvent({ type: "turn.done", turn: { id, role, transcript } });
    };
    said("u1", "user", "Tell the other thread to deploy");
    said("a1", "assistant", "Which one?");
    said("u2", "user", ", go ahead");
    delegate("item-1", ", go ahead");
    expect(dispatch).toHaveBeenLastCalledWith(
      "sent-1",
      "Tell the other thread to deploy, go ahead",
      false,
    );

    // The next request starts fresh, and text the model wrote itself goes as it is.
    said("u3", "user", "um can you fix the uh login bug");
    delegate("item-2", "Fix the login bug.");
    expect(dispatch).toHaveBeenLastCalledWith("sent-2", "Fix the login bug.", true);
  });

  it("steers a working agent and tells the voice model quietly", async () => {
    const { dispatch, delegate, sent } = setup(thread(true));
    delegate("item-2", "use blue instead");
    await settled();
    expect(dispatch).toHaveBeenCalledWith("sent-1", "use blue instead", true);
    expect(sent()).toEqual([
      "item-2/commentary: This was sent to the work already in progress, which will take it into account.",
    ]);
  });

  it("reports a request that could not be sent and stops treating the agent as working", async () => {
    const { conversation, dispatch, delegate, sent, view } = setup();
    dispatch.mockRejectedValueOnce(new Error("offline"));
    delegate("item-1", "run the tests");
    await settled();
    expect(sent()).toEqual([
      "item-1/speakable: The request could not be sent. Tell the user it did not go through.",
    ]);
    expect(conversation.working).toBe(false);
    expect(view.requests).toEqual(["run the tests: failed"]);
  });

  it("tells the call about typed messages, their results, and requests waiting for the user", () => {
    const { conversation, sent } = setup();
    conversation.threadChanged(
      thread(true, [{ id: "typed", role: "user", text: "fix the build", streaming: false }]),
    );
    expect(sent()).toEqual(["call/commentary: The user typed in the app: fix the build"]);
    conversation.threadChanged(thread(true, [], true));
    conversation.threadChanged(thread(true, [], true));
    expect(sent()).toEqual([
      "call/speakable: The work is waiting for the user to answer a request in the app before it can continue. Tell the user.",
    ]);
    conversation.threadChanged(
      thread(false, [{ id: "a1", role: "assistant", text: "Build fixed.", streaming: false }]),
    );
    expect(sent()).toEqual(["call/speakable: Build fixed."]);
  });

  it("shows each side's words as they are heard, then the finished transcript", () => {
    const { conversation, view } = setup();
    // Shapes recorded from a live call: a turn opens with its first words, then grows by deltas.
    const delta = (turn_id: string, text: string) =>
      conversation.handleEvent({ type: "turn.delta", turn_id, delta: text });
    conversation.handleEvent({
      type: "turn.created",
      turn: { id: "u1", role: "user", transcript: " Hey" },
    });
    delta("u1", ", can you");
    delta("u1", " run it");
    conversation.handleEvent({
      type: "turn.done",
      turn: { id: "u1", role: "user", transcript: " Hey, can you run it" },
    });
    conversation.handleEvent({
      type: "turn.created",
      turn: { id: "a1", role: "assistant", transcript: " Sure" },
    });
    delta("a1", ", on it.");
    delta("u1", " ignored after the turn ended");
    expect(view.captions).toEqual([
      "user…: Hey",
      "user…: Hey, can you",
      "user…: Hey, can you run it",
      "user: Hey, can you run it",
      "assistant…: Sure",
      "assistant…: Sure, on it.",
    ]);
  });
});
