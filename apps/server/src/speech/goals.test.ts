import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as VoiceGoals from "./goals.ts";

const withReply = (reply: string, prompts: Array<string> = []) =>
  VoiceGoals.layer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({
        generateTranscriptionPostProcessing: (input) =>
          Effect.sync(() => {
            prompts.push(input.prompt);
            return { transcription: reply };
          }),
      }),
    ),
  );

const run = (reply: string, prompts?: Array<string>) =>
  VoiceGoals.VoiceGoals.pipe(
    Effect.flatMap((service) =>
      service.update({
        goals: [{ id: "g1", text: "Fix the build", status: "active" }],
        update: { request: "also add a dark mode toggle" },
      }),
    ),
    Effect.provide(withReply(reply, prompts)),
  );

it.effect("asks the text model with the current goals and adopts its answer", () =>
  Effect.gen(function* () {
    const prompts: Array<string> = [];
    const result = yield* run(
      'Here you go: {"goals":[{"id":"g1","text":"Fix the build","status":"active"},{"id":"g2","text":"Add a dark mode toggle","status":"active"}]}',
      prompts,
    );
    expect(result.goals.map(({ id, text }) => `${id}: ${text}`)).toEqual([
      "g1: Fix the build",
      "g2: Add a dark mode toggle",
    ]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"text":"Fix the build"');
    expect(prompts[0]).toContain("also add a dark mode toggle");
  }),
);

it.effect("falls back to a plain list when the model's answer is unusable", () =>
  Effect.gen(function* () {
    const result = yield* run("I could not do that.");
    expect(result.goals.map(({ id, text }) => `${id}: ${text}`)).toEqual([
      "g1: Fix the build",
      "g2: also add a dark mode toggle",
    ]);
  }),
);
