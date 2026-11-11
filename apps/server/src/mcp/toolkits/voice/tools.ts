import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as VoiceCallControl from "../../../speech/callControl.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const VoiceCallEndTool = Tool.make("t3_voice_call_end", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    VoiceCallControl.VoiceCallControl,
  ],
  description:
    "Hang up the voice call open on this thread when the user asks to end it. Your work continues. `hungUp:false`: no call was open.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ hungUp: Schema.Boolean }),
}).annotate(Tool.Destructive, false);

export const VoiceToolkit = Toolkit.make(VoiceCallEndTool);
