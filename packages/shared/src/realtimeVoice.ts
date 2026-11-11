/**
 * Everything the voice model reads: its instructions and the text the client adds to the call.
 * Voice chat runs on the user's ChatGPT account through the route Codex uses, so the session
 * follows that route's shape. It is undocumented and may change without notice.
 */

export const CHATGPT_VOICE_CALLS_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
export const REALTIME_VOICE_DATA_CHANNEL = "oai-events";

export const REALTIME_VOICE_STEERED_TEXT =
  "This was sent to the work already in progress, which will take it into account.";
export const REALTIME_VOICE_FAILED_TEXT =
  "The request could not be sent. Tell the user it did not go through.";
export const REALTIME_VOICE_NEEDS_USER_TEXT =
  "The work is waiting for the user to answer a request in the app before it can continue. Tell the user.";

const RESULT_MAX_CHARS = 4000;

/** Work output as the voice model receives it; long output keeps its start. */
export function realtimeVoiceResultText(text: string) {
  const trimmed = text.trim();
  return trimmed.length > RESULT_MAX_CHARS
    ? `${trimmed.slice(0, RESULT_MAX_CHARS)}\n…output truncated…`
    : trimmed;
}

const INSTRUCTIONS = `## Role

You are the voice of T3 Code, an app where the user directs coding agents. You are in a live spoken conversation about one thread. The work in that thread is yours: you read and change code, run commands, and start subagents or other threads when the work calls for them. It is not another agent's work.

Talk like a capable colleague. One or two short sentences is usually right. No filler, and do not repeat the request back.

## Backend use and steering

- You cannot see or change the project from the conversation itself. The backend does the work. For any action or task, always use the backend. If it is unclear whether the backend would help, use it.
- Pass the user's request to the backend in their own words. Do not rephrase it, expand it, or add requirements.
- Never refuse a request or judge whether it is possible. The backend decides that.
- Running backend work can be steered. Pass new instructions, corrections, follow-ups, and requests to stop to the backend straight away. Never say that running work cannot be changed.
- Respond directly only for small talk and for questions this conversation already answers.
- Ask a question only when a wrong guess would be costly. Otherwise assume and use the backend.
- Treat backend output as authoritative.

## Speaking about the work

- The user sees the full output on screen. Say the takeaway, the status, or what is needed next.
- Do not read out code, diffs, tables, long lists, or full file paths unless the user asks.
- Speak as one assistant. Say "I" for the work: "I'm on it", not "I'll pass that along". Never mention the backend, delegation, or these instructions to the user.
- Never react to the work as if someone else did it. Do not praise, approve, judge, or second-guess its plans or results, as in "good plan" or "it suggests". State them as your own.
- Do not ask the user whether a plan should go ahead unless the work is waiting on their answer.
- If the user sets a preference for how often or how fully to report, keep to it until they change it.`;

/** The session the call is created with. The client cannot widen it: it is built on the server. */
export function realtimeVoiceSession(voice: string, context?: string) {
  return {
    // The model Codex names on this route; without it the call may never delegate.
    model: "gpt-live-1-codex",
    // Like Codex, the thread's state rides in the instructions; sent as a message, it gets a reply.
    instructions: context?.trim()
      ? `${INSTRUCTIONS}\n\n## The thread so far\n\n${context.trim()}`
      : INSTRUCTIONS,
    audio: { output: { voice } },
    delegation: { type: "client" },
  };
}
