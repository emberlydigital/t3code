import type { VoiceGoalsRequest, VoiceGoalsResult } from "@t3tools/contracts";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";
import {
  buildVoiceGoalsPrompt,
  fallbackVoiceGoals,
  parseVoiceGoals,
} from "@t3tools/shared/voiceGoals";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { SpeechOperationError } from "./SpeechService.ts";

/**
 * Keeps a voice call's goal list: what the user asked for, in a few words, and whether it is
 * done. It borrows the voice cleanup model, and a reply it cannot use falls back to a plain list
 * rather than failing, so the call never loses its goals to a bad model answer.
 */
export class VoiceGoals extends Context.Service<
  VoiceGoals,
  {
    readonly update: (
      input: VoiceGoalsRequest,
    ) => Effect.Effect<VoiceGoalsResult, SpeechOperationError>;
  }
>()("t3/speech/goals/VoiceGoals") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const textGeneration = yield* TextGeneration.TextGeneration;
  return VoiceGoals.of({
    update: Effect.fn("VoiceGoals.update")(
      function* ({ goals, update }) {
        const settings = yield* settingsService.getSettings;
        // Providers run in a working directory; summarizing must not read a checkout.
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-goals-" });
        const generated = yield* textGeneration.generateTranscriptionPostProcessing({
          cwd,
          prompt: buildVoiceGoalsPrompt(goals, update),
          modelSelection: resolveSpeechPostProcessingModelSelection(settings),
        });
        return {
          goals:
            parseVoiceGoals(generated.transcription, goals) ?? fallbackVoiceGoals(goals, update),
        };
      },
      Effect.scoped,
      Effect.mapError((cause) => new SpeechOperationError({ operation: "goal summary", cause })),
    ),
  });
});

export const layer = Layer.effect(VoiceGoals, make);
