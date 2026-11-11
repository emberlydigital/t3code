import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as VoiceCallControl from "../../../speech/callControl.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as VoiceHandlers from "./handlers.ts";
import { VoiceToolkit } from "./tools.ts";

const threadId = ThreadId.make("voice-tool-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("voice-tool-environment"),
  requestNamespace: "voice-tool-provider-session",
  thread: {
    threadId,
    providerSessionId: "voice-tool-provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 0,
};

it.effect("ending the call answers the open question of the thread that called, and says so", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* VoiceCallControl.VoiceCallControl.pipe(
        Effect.provide(VoiceCallControl.layer),
      );
      const layerDependencies = Layer.mergeAll(
        Layer.succeed(VoiceCallControl.VoiceCallControl, control),
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        McpToolAccessTestkit.liveThreadsLayer,
      );
      const toolkit = yield* VoiceToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(VoiceHandlers.layer).pipe(
            Layer.provide(layerDependencies),
          ),
        ),
      );
      const endCall = () =>
        toolkit
          .handle("t3_voice_call_end", {})
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

      // No call is open on the thread.
      expect((yield* endCall()).at(-1)?.result).toEqual({ hungUp: false });

      // The app is asking; the agent's tool call answers it.
      const asking = yield* Effect.forkChild(control.waitForHangUp(threadId));
      yield* Effect.yieldNow;
      expect((yield* endCall()).at(-1)?.result).toEqual({ hungUp: true });
      expect(yield* Fiber.join(asking)).toBe(true);
    }),
  ),
);
