import {
  VOICE_GOALS_MAX,
  VoiceGoalsResult,
  type VoiceGoal,
  type VoiceGoalUpdate,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const GOAL_TEXT_MAX = 120;
const FALLBACK_TEXT_MAX = 60;
const decodeGoals = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceGoalsResult));

/** The model-facing instructions for keeping a call's goal list up to date. */
export function buildVoiceGoalsPrompt(goals: ReadonlyArray<VoiceGoal>, update: VoiceGoalUpdate) {
  const event = [
    `The user asked: ${JSON.stringify(update.request)}`,
    update.outcome ? `That work ended: ${update.outcome}.` : "That work has just started.",
    update.result ? `The agent's final message: ${JSON.stringify(update.result)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `You keep a short list of the goals a user has set during a voice call in which they direct a coding agent. Update the list for the event below and return the whole list.

Rules:
- A goal is an outcome the user wants, in at most 8 plain words starting with a verb, such as "Add a dark mode toggle". It is never their words, a greeting, or a transcript.
- A request that continues, refines or corrects an existing active goal updates that goal instead of adding another.
- Ignore small talk, filler, and thinking out loud: add nothing for them. A request to end or hang up the call is not a goal either.
- If the work ended "done" and the agent's message shows the goal was met, mark it "done". If the message shows it was only partly met, keep it "active" and reword it to what is left.
- If the work ended "stopped", mark that goal "dropped". If it "failed", keep it "active".
- Keep every existing goal's id and order. A new goal gets the next id, "g" plus the next number.
- Keep at most ${VOICE_GOALS_MAX} goals; remove the oldest "done" or "dropped" ones first.

Current goals:
${JSON.stringify({ goals })}

Event:
${event}

Reply with only JSON in this shape, nothing else: {"goals":[{"id":"g1","text":"...","status":"active"}]}`;
}

const nextId = (goals: ReadonlyArray<{ readonly id: string }>) =>
  `g${goals.reduce((highest, { id }) => Math.max(highest, Number(id.slice(1)) || 0), 0) + 1}`;

/** Keeps the newest goals, preferring to drop finished ones. */
function limit(goals: ReadonlyArray<VoiceGoal>): ReadonlyArray<VoiceGoal> {
  let result = goals;
  while (result.length > VOICE_GOALS_MAX) {
    const finished = result.findIndex(({ status }) => status !== "active");
    result = result.filter((_, index) => index !== (finished === -1 ? 0 : finished));
  }
  return result;
}

/**
 * Reads the model's reply. Anything unusable returns null, so a bad reply never replaces the
 * list: an empty answer to a non-empty list counts as unusable.
 */
export function parseVoiceGoals(
  reply: string,
  previous: ReadonlyArray<VoiceGoal>,
): ReadonlyArray<VoiceGoal> | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const decoded = decodeGoals(reply.slice(start, end + 1));
  if (Option.isNone(decoded)) return null;
  const seen = new Set<string>();
  const goals: Array<VoiceGoal> = [];
  for (const goal of decoded.value.goals) {
    const text = goal.text.trim().slice(0, GOAL_TEXT_MAX);
    if (text === "") continue;
    const id = seen.has(goal.id) ? nextId([...goals, ...previous]) : goal.id;
    seen.add(id);
    goals.push({ id, text, status: goal.status });
  }
  if (goals.length === 0 && previous.length > 0) return null;
  return limit(goals);
}

/**
 * The list without a model: a new request becomes a goal in its own first line, and an ending
 * settles the newest active goal. Rougher than the model, but the list never goes blank.
 */
export function fallbackVoiceGoals(
  goals: ReadonlyArray<VoiceGoal>,
  update: VoiceGoalUpdate,
): ReadonlyArray<VoiceGoal> {
  if (update.outcome === undefined) {
    const line = update.request.trim().split(/\r?\n/, 1)[0] ?? "";
    if (line === "") return goals;
    const text =
      line.length > FALLBACK_TEXT_MAX ? `${line.slice(0, FALLBACK_TEXT_MAX - 1)}…` : line;
    return limit([...goals, { id: nextId(goals), text, status: "active" }]);
  }
  if (update.outcome === "failed") return goals;
  const target = goals.findLast(({ status }) => status === "active");
  if (target === undefined) return goals;
  const status = update.outcome === "done" ? "done" : "dropped";
  return goals.map((goal) => (goal.id === target.id ? { ...goal, status } : goal));
}
