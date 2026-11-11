import type { VoiceGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildVoiceGoalsPrompt, fallbackVoiceGoals, parseVoiceGoals } from "./voiceGoals.ts";

const active = (id: string, text: string): VoiceGoal => ({ id, text, status: "active" });

describe("parseVoiceGoals", () => {
  it("reads a reply wrapped in prose or a code fence", () => {
    const reply =
      'Sure!\n```json\n{"goals":[{"id":"g1","text":" Add a toggle ","status":"active"}]}\n```';
    expect(parseVoiceGoals(reply, [])).toEqual([active("g1", "Add a toggle")]);
  });

  it("never lets an unusable reply replace the list", () => {
    const previous = [active("g1", "Fix the build")];
    for (const reply of [
      "no json",
      '{"goals":"nope"}',
      '{"goals":[{"id":"g1","text":"x","status":"?"}]}',
    ])
      expect(parseVoiceGoals(reply, previous)).toBeNull();
    // An empty answer to a non-empty list would silently wipe it.
    expect(parseVoiceGoals('{"goals":[]}', previous)).toBeNull();
    expect(parseVoiceGoals('{"goals":[]}', [])).toEqual([]);
  });

  it("repairs duplicate ids and keeps at most eight goals, dropping finished ones first", () => {
    const duplicate = parseVoiceGoals(
      '{"goals":[{"id":"g1","text":"A","status":"active"},{"id":"g1","text":"B","status":"active"}]}',
      [],
    );
    expect(duplicate?.map(({ id }) => id)).toEqual(["g1", "g2"]);
    const nine = Array.from({ length: 9 }, (_, index) => ({
      id: `g${index + 1}`,
      text: `Goal ${index + 1}`,
      status: index === 3 ? "done" : "active",
    }));
    const limited = parseVoiceGoals(JSON.stringify({ goals: nine }), []);
    expect(limited).toHaveLength(8);
    expect(limited?.some(({ id }) => id === "g4")).toBe(false);
  });
});

describe("fallbackVoiceGoals", () => {
  it("turns a request into a short goal and settles the newest active goal on an ending", () => {
    const first = fallbackVoiceGoals([], {
      request: "Add a dark mode toggle\nplease make it blue",
    });
    expect(first).toEqual([active("g1", "Add a dark mode toggle")]);
    const two = fallbackVoiceGoals(first, { request: "x".repeat(100) });
    expect(two[1]?.text).toHaveLength(60);
    expect(two[1]?.id).toBe("g2");
    expect(
      fallbackVoiceGoals(two, { request: "", outcome: "done" }).map(({ status }) => status),
    ).toEqual(["active", "done"]);
    expect(fallbackVoiceGoals(two, { request: "", outcome: "stopped" })[1]?.status).toBe("dropped");
    expect(fallbackVoiceGoals(two, { request: "", outcome: "failed" })).toEqual(two);
  });
});

describe("buildVoiceGoalsPrompt", () => {
  it("carries the current goals and the event, quoting user text", () => {
    const prompt = buildVoiceGoalsPrompt([active("g1", "Fix the build")], {
      request: 'say "hi"',
      outcome: "done",
      result: "Fixed.",
    });
    expect(prompt).toContain('"id":"g1"');
    expect(prompt).toContain('The user asked: "say \\"hi\\""');
    expect(prompt).toContain("That work ended: done.");
    expect(prompt).toContain('The agent\'s final message: "Fixed."');
  });
});
