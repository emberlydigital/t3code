import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as VoiceCallControl from "./callControl.ts";

const thread = ThreadId.make("thread-1");
const control = VoiceCallControl.VoiceCallControl.pipe(Effect.provide(VoiceCallControl.layer));

it.effect("answers the app's open question the moment a hang-up is requested", () =>
  Effect.gen(function* () {
    const service = yield* control;
    const asking = yield* Effect.forkChild(service.waitForHangUp(thread));
    yield* Effect.yieldNow;
    expect(yield* service.requestHangUp(thread)).toEqual({ listening: true });
    expect(yield* Fiber.join(asking)).toBe(true);
  }),
);

it.effect("asks again when nothing happens, and holds a hang-up that lands between questions", () =>
  Effect.gen(function* () {
    const service = yield* control;
    const first = yield* Effect.forkChild(service.waitForHangUp(thread));
    yield* TestClock.adjust(VoiceCallControl.HANG_UP_WAIT_MS);
    expect(yield* Fiber.join(first)).toBe(false);
    // The app is between two questions, so the hang-up waits for the next one.
    expect(yield* service.requestHangUp(thread)).toEqual({ listening: true });
    expect(yield* service.waitForHangUp(thread)).toBe(true);
    // And it counts once: the question after that waits as usual.
    const next = yield* Effect.forkChild(service.waitForHangUp(thread));
    yield* TestClock.adjust(VoiceCallControl.HANG_UP_WAIT_MS);
    expect(yield* Fiber.join(next)).toBe(false);
  }),
);

it.effect("reports no call when the app has stopped asking", () =>
  Effect.gen(function* () {
    const service = yield* control;
    expect(yield* service.requestHangUp(thread)).toEqual({ listening: false });
    const ask = yield* Effect.forkChild(service.waitForHangUp(thread));
    yield* TestClock.adjust(VoiceCallControl.HANG_UP_WAIT_MS);
    yield* Fiber.join(ask);
    yield* TestClock.adjust(60_000);
    expect(yield* service.requestHangUp(thread)).toEqual({ listening: false });
    // A call opened later is not hung up by a request nobody was there to hear.
    const later = yield* Effect.forkChild(service.waitForHangUp(thread));
    yield* TestClock.adjust(VoiceCallControl.HANG_UP_WAIT_MS);
    expect(yield* Fiber.join(later)).toBe(false);
  }),
);

it.effect("keeps threads apart", () =>
  Effect.gen(function* () {
    const service = yield* control;
    const other = ThreadId.make("thread-2");
    const asking = yield* Effect.forkChild(service.waitForHangUp(thread));
    yield* Effect.yieldNow;
    expect(yield* service.requestHangUp(other)).toEqual({ listening: false });
    yield* service.requestHangUp(thread);
    expect(yield* Fiber.join(asking)).toBe(true);
  }),
);
