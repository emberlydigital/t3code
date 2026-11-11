import type { VoiceGoal, VoiceGoalUpdate } from "@t3tools/contracts";
import { fallbackVoiceGoals } from "@t3tools/shared/voiceGoals";
import { expect, it, vi } from "vite-plus/test";

import {
  RealtimeVoiceCall,
  type RealtimeVoiceCallDependencies,
  type RealtimeVoiceTransport,
} from "./realtimeVoiceCall.ts";

function fakeTransport() {
  const listeners = {
    open: [] as Array<() => void>,
    message: [] as Array<(data: string) => void>,
  };
  const transport = {
    createOffer: vi.fn(async () => "offer"),
    acceptAnswer: vi.fn(async (_sdp: string) => undefined),
    send: vi.fn((_data: string) => undefined),
    onOpen: (listener) => listeners.open.push(listener),
    onMessage: (listener) => listeners.message.push(listener),
    onLost: () => undefined,
    setMicrophoneEnabled: vi.fn((_enabled: boolean) => undefined),
    fadeOut: () => 200,
    close: vi.fn(() => undefined),
  } satisfies RealtimeVoiceTransport;
  return {
    transport,
    open: () => listeners.open.forEach((listener) => listener()),
    receive: (event: unknown) =>
      listeners.message.forEach((listener) => listener(JSON.stringify(event))),
  };
}

const pendingUntilAborted = (signal: AbortSignal) =>
  new Promise<boolean>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason)),
  );

function setup(overrides: Partial<RealtimeVoiceCallDependencies> = {}) {
  const line = fakeTransport();
  const deps = {
    openTransport: async () => line.transport,
    answerOffer: async () => "answer",
    dispatch: vi.fn(async () => undefined),
    newMessageId: (() => {
      let next = 0;
      return () => `m${++next}`;
    })(),
    readThread: () => ({ working: false, needsUser: false, messages: [] }),
    subscribeThread: () => () => undefined,
    updateGoals: async (goals: ReadonlyArray<VoiceGoal>) => goals,
    waitForHangUp: pendingUntilAborted,
    onState: () => undefined,
    onFailed: vi.fn(),
    playStartSound: vi.fn(),
    playEndSound: vi.fn(),
    ...overrides,
  } satisfies RealtimeVoiceCallDependencies;
  return { line, deps, call: new RealtimeVoiceCall(deps) };
}

it("hangs up for an agent once the goodbye has been spoken, then closes the line after the fade", async () => {
  vi.useFakeTimers();
  let answerHangUp = (_hangUp: boolean) => {};
  const waitForHangUp = vi.fn((signal: AbortSignal) =>
    waitForHangUp.mock.calls.length === 1
      ? new Promise<boolean>((resolve) => (answerHangUp = resolve))
      : pendingUntilAborted(signal),
  );
  const { line, deps, call } = setup({ waitForHangUp });
  await call.start();
  line.open();
  expect(call.state.status).toBe("live");
  expect(deps.playStartSound).toHaveBeenCalledOnce();

  line.receive({ type: "turn.created", turn: { id: "a1", role: "assistant", transcript: "Bye" } });
  answerHangUp(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(call.ended).toBe(false);

  line.receive({ type: "turn.done", turn: { id: "a1", role: "assistant", transcript: "Bye!" } });
  await vi.advanceTimersByTimeAsync(400);
  expect(call.ended).toBe(true);
  expect(call.state.status).toBe("idle");
  expect(deps.playEndSound).toHaveBeenCalledOnce();
  expect(line.transport.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
  expect(line.transport.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(line.transport.close).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

it("summarizes goals one update at a time and keeps going when a summary fails", async () => {
  let finishFirst = (_goals: ReadonlyArray<VoiceGoal>) => {};
  const seen: Array<ReadonlyArray<VoiceGoal>> = [];
  const updateGoals = vi.fn((goals: ReadonlyArray<VoiceGoal>, _update: VoiceGoalUpdate) => {
    seen.push(goals);
    return seen.length === 1
      ? new Promise<ReadonlyArray<VoiceGoal>>((resolve) => (finishFirst = resolve))
      : Promise.reject(new Error("summary failed"));
  });
  const { line, call } = setup({ updateGoals });
  await call.start();
  line.open();
  const delegate = (id: string, text: string) =>
    line.receive({
      type: "delegation.created",
      item: { id, type: "delegation", target: "client", content: [{ type: "input_text", text }] },
    });
  delegate("d1", "Fix the login bug");
  delegate("d2", "Also run the tests");
  await vi.waitFor(() => expect(updateGoals).toHaveBeenCalledOnce());

  const first: ReadonlyArray<VoiceGoal> = [{ id: "g1", text: "Fix login", status: "active" }];
  finishFirst(first);
  await vi.waitFor(() => expect(updateGoals).toHaveBeenCalledTimes(2));
  expect(seen[1]).toBe(first);
  await vi.waitFor(() =>
    expect(call.state.goals).toEqual(fallbackVoiceGoals(first, { request: "Also run the tests" })),
  );
  call.end();
});

it("reports a call that could not connect without playing the hang-up sound", async () => {
  const denied = new Error("microphone denied");
  const { deps, call } = setup({ openTransport: () => Promise.reject(denied) });
  await call.start();
  expect(deps.onFailed).toHaveBeenCalledWith(denied);
  expect(deps.playEndSound).not.toHaveBeenCalled();
  expect(call.state.status).toBe("idle");
});
