import * as Effect from "effect/Effect";
import * as VoiceCallControl from "../../../speech/callControl.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { VoiceToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(VoiceToolkit, {
  t3_voice_call_end: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const control = yield* VoiceCallControl.VoiceCallControl;
      const { listening } = yield* control.requestHangUp(
        (yield* McpInvocationContext.requireThreadScope(scope, "t3_voice_call_end")).thread
          .threadId,
      );
      return { hungUp: listening };
    }),
  ),
});
