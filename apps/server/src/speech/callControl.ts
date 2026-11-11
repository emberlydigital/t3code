import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** How long the app's question stays open before it asks again. */
export const HANG_UP_WAIT_MS = 25_000;
/** An app that asked this recently is still there: it is between two questions. */
const STILL_LISTENING_MS = 10_000;
/** A hang-up that lands between two questions waits this long for the next one. */
const HANG_UP_HOLD_MS = 15_000;

interface State {
  readonly waiters: ReadonlyMap<ThreadId, ReadonlyArray<Deferred.Deferred<void>>>;
  /** Hang-ups that arrived while no question was open, by when they stop counting. */
  readonly held: ReadonlyMap<ThreadId, number>;
  /** When each thread's app last asked or finished asking. */
  readonly lastAsked: ReadonlyMap<ThreadId, number>;
}

const withEntry = <V>(map: ReadonlyMap<ThreadId, V>, threadId: ThreadId, value: V) =>
  new Map(map).set(threadId, value);
const withoutEntry = <V>(map: ReadonlyMap<ThreadId, V>, threadId: ThreadId) => {
  const next = new Map(map);
  next.delete(threadId);
  return next;
};

/**
 * Lets an agent hang up the voice call its user has open on the thread. The call lives in the
 * app, so the app keeps one question open here, "should I hang up?", and an agent's tool call
 * answers it. Nothing is kept for an app that has gone: a hang-up with nobody listening reports so.
 */
export class VoiceCallControl extends Context.Service<
  VoiceCallControl,
  {
    /** Asks the app to hang up. `listening` is false when no call is open on the thread. */
    readonly requestHangUp: (threadId: ThreadId) => Effect.Effect<{ readonly listening: boolean }>;
    /** The app's open question: true once a hang-up is requested, false when it should ask again. */
    readonly waitForHangUp: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/speech/callControl/VoiceCallControl") {}

const make = Effect.gen(function* () {
  const state = yield* Ref.make<State>({
    waiters: new Map(),
    held: new Map(),
    lastAsked: new Map(),
  });

  const requestHangUp = Effect.fn("VoiceCallControl.requestHangUp")(function* (threadId: ThreadId) {
    const now = yield* Clock.currentTimeMillis;
    const open = yield* Ref.modify(state, (current) => {
      const waiting = current.waiters.get(threadId) ?? [];
      const listening =
        waiting.length > 0 ||
        now - (current.lastAsked.get(threadId) ?? -Infinity) < STILL_LISTENING_MS;
      return [
        { waiting, listening },
        {
          ...current,
          waiters: withoutEntry(current.waiters, threadId),
          held:
            waiting.length === 0 && listening
              ? withEntry(current.held, threadId, now + HANG_UP_HOLD_MS)
              : current.held,
        },
      ] as const;
    });
    yield* Effect.forEach(open.waiting, (waiter) => Deferred.succeed(waiter, undefined), {
      discard: true,
    });
    return { listening: open.listening };
  });

  const waitForHangUp = Effect.fn("VoiceCallControl.waitForHangUp")(function* (threadId: ThreadId) {
    const now = yield* Clock.currentTimeMillis;
    const waiter = yield* Deferred.make<void>();
    const requested = yield* Ref.modify(state, (current) => {
      const until = current.held.get(threadId);
      const base = {
        ...current,
        held: until === undefined ? current.held : withoutEntry(current.held, threadId),
        lastAsked: withEntry(current.lastAsked, threadId, now),
      };
      if (until !== undefined && until > now) return [true, base] as const;
      return [
        false,
        {
          ...base,
          waiters: withEntry(current.waiters, threadId, [
            ...(current.waiters.get(threadId) ?? []),
            waiter,
          ]),
        },
      ] as const;
    });
    if (requested) return true;
    const leave = Effect.gen(function* () {
      const left = yield* Clock.currentTimeMillis;
      yield* Ref.update(state, (current) => ({
        ...current,
        waiters: withEntry(
          current.waiters,
          threadId,
          (current.waiters.get(threadId) ?? []).filter((other) => other !== waiter),
        ),
        lastAsked: withEntry(current.lastAsked, threadId, left),
      }));
    });
    return yield* Deferred.await(waiter).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({ duration: HANG_UP_WAIT_MS, orElse: () => Effect.succeed(false) }),
      Effect.ensuring(leave),
    );
  });

  return VoiceCallControl.of({ requestHangUp, waitForHangUp });
});

export const layer = Layer.effect(VoiceCallControl, make);
