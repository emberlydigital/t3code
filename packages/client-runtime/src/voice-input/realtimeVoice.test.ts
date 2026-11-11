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
  const interrupt = vi.fn(async () => undefined);
  let nextId = 0;
  const view = { requests: [] as ReadonlyArray<string>, captions: [] as Array<string> };
  const conversation = new RealtimeVoiceConversation(
    {
      send: (event) => events.push(event),
      onRequests: (requests) => {
        view.requests = requests.map((request) => `${request.prompt}: ${request.status}`);
      },
      onCaption: (caption) =>
        view.captions.push(`${caption.role}${caption.live ? "…" : ""}: ${caption.text}`),
      newMessageId: () => `sent-${++nextId}`,
      dispatch,
      interrupt,
    },
    initial,
  );
  const call = (name: string, callId: string, args: object = {}) => {
    conversation.handleEvent({ type: "response.created" });
    conversation.handleEvent({
      type: "response.done",
      response: {
        output: [{ type: "function_call", name, call_id: callId, arguments: JSON.stringify(args) }],
      },
    });
  };
  /** Sent events as short strings: said text, `callId=output`, or `respond`. */
  const sent = () =>
    events.splice(0).map((event) => {
      if (event.type === "response.create") return "respond";
      const item = event.item as {
        type: string;
        call_id?: string;
        output?: string;
        content?: ReadonlyArray<{ text: string }>;
      };
      return item.type === "function_call_output"
        ? `${item.call_id}=${item.output}`
        : item.content![0]!.text;
    });
  return { conversation, dispatch, interrupt, call, sent, view };
}

const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("RealtimeVoiceConversation", () => {
  it("hands a spoken request to the idle agent and returns the call when the agent goes idle", async () => {
    const { conversation, dispatch, call, sent, view } = setup(
      thread(false, [{ id: "old", role: "assistant", text: "Earlier answer", streaming: false }]),
    );
    call("background_agent", "call-1", { prompt: "[USER] add a toggle" });
    expect(dispatch).toHaveBeenCalledWith("sent-1", "add a toggle", false);
    await settled();
    // The thread has not shown the message yet, so an idle snapshot is not the end of the work.
    conversation.threadChanged(thread(false));
    expect(sent()).toEqual([]);
    const request = { id: "sent-1", role: "user", text: "add a toggle", streaming: false } as const;
    conversation.threadChanged(
      thread(true, [request, { id: "a1", role: "assistant", text: "Working", streaming: true }]),
    );
    expect(sent()).toEqual([]);
    conversation.threadChanged(
      thread(false, [
        request,
        { id: "a1", role: "assistant", text: "Added it.", streaming: false },
      ]),
    );
    expect(sent()).toEqual([
      "[BACKEND] Added it.",
      "call-1=The agent finished. Use the preceding [BACKEND] messages as the result.",
      "respond",
    ]);
    expect(view.requests).toEqual(["add a toggle: done"]);
  });

  it("steers a working agent and waits for the current response before asking for another", async () => {
    const { conversation, dispatch, call, sent } = setup(thread(true));
    conversation.handleEvent({ type: "response.created" });
    conversation.handleEvent({
      type: "response.done",
      response: {
        output: [
          {
            type: "function_call",
            name: "background_agent",
            call_id: "call-1",
            arguments: JSON.stringify({ prompt: "use blue instead" }),
          },
        ],
      },
    });
    conversation.handleEvent({ type: "response.created" });
    await settled();
    expect(dispatch).toHaveBeenCalledWith("sent-1", "use blue instead", true);
    expect(sent()).toEqual([
      "call-1=This was sent to the agent, which is already working. It will take it into account.",
    ]);
    conversation.handleEvent({ type: "response.done", response: { output: [] } });
    expect(sent()).toEqual(["respond"]);
    call("background_agent", "call-2", { prompt: "" });
    expect(sent()[0]).toMatch(/^call-2=The request could not be sent/);
  });

  it("reports a request that could not be sent and stops treating the agent as working", async () => {
    const { conversation, dispatch, call, sent, view } = setup();
    dispatch.mockRejectedValueOnce(new Error("offline"));
    call("background_agent", "call-1", { prompt: "run the tests" });
    await settled();
    expect(sent()).toEqual([
      "call-1=The request could not be sent to the agent. Tell the user it did not go through.",
      "respond",
    ]);
    expect(conversation.working).toBe(false);
    expect(view.requests).toEqual(["run the tests: failed"]);
  });

  it("stops the agent on request without announcing that it finished", async () => {
    const { conversation, interrupt, call, sent, view } = setup();
    call("interrupt_agent", "call-0");
    expect(interrupt).not.toHaveBeenCalled();
    expect(sent()).toEqual(["call-0=The agent is not working on anything.", "respond"]);
    conversation.handleEvent({ type: "response.done", response: { output: [] } });
    call("background_agent", "call-1", { prompt: "refactor everything" });
    conversation.threadChanged(
      thread(true, [{ id: "sent-1", role: "user", text: "refactor everything", streaming: false }]),
    );
    call("interrupt_agent", "call-2");
    await settled();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(sent()).toEqual(["call-2=The agent was stopped.", "respond"]);
    conversation.threadChanged(
      thread(false, [{ id: "a1", role: "assistant", text: "Partial", streaming: false }]),
    );
    expect(sent()).toEqual(["[BACKEND] Partial", "call-1=The agent was stopped."]);
    expect(view.requests).toEqual(["refactor everything: stopped"]);
  });

  it("tells the voice model about typed messages, their results, and requests waiting for the user", () => {
    const { conversation, sent } = setup();
    conversation.threadChanged(
      thread(true, [{ id: "typed", role: "user", text: "fix the build", streaming: false }]),
    );
    expect(sent()).toEqual(["[USER] fix the build"]);
    conversation.threadChanged(thread(true, [], true));
    conversation.threadChanged(thread(true, [], true));
    expect(sent()).toEqual([
      "[BACKEND] The agent is waiting for the user to answer a request in the app before it can continue. Tell the user.",
      "respond",
    ]);
    conversation.handleEvent({ type: "response.done", response: { output: [] } });
    conversation.threadChanged(
      thread(false, [{ id: "a1", role: "assistant", text: "Build fixed.", streaming: false }]),
    );
    expect(sent()).toEqual(["[BACKEND] Build fixed.", "respond"]);
  });

  it("shows the user's words as they are heard, then the finished transcript", () => {
    const { conversation, view } = setup();
    const delta = (item_id: string, text: string) =>
      conversation.handleEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id,
        delta: text,
      });
    delta("a", "fix the");
    delta("a", " build");
    conversation.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a",
      transcript: "Fix the build.",
    });
    delta("b", "and");
    expect(view.captions).toEqual([
      "user…: fix the",
      "user…: fix the build",
      "user: Fix the build.",
      "user…: and",
    ]);
  });
});
