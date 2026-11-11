# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text to the agent. Mobile defaults to on-device transcription. Sending audio off
the device requires an explicit grant naming one environment and, for cloud
transcription, one provider.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced. A
transcriber may expose a streaming session, in which case audio leaves during
capture and `finish` replaces the file-based `transcribe`.

## Where audio may go

On mobile, on-device transcription needs no audio grant. Environment and cloud
transcription share a recorder and upload only finished recordings. The client
keeps the grant in device-bound secure storage, outside preference backups, and
rechecks it after native decoding and before upload.

The [web grant](../../apps/web/src/speech/voiceConsent.ts) lives outside the preferences snapshot so another
window saving unrelated settings cannot resurrect a revoked grant. Each new choice
gets a distinct grant, even if the destination was previously selected. The
[web hook](../../apps/web/src/speech/useEnvironmentSpeechInput.ts) binds the
controller to that grant and the selected environment's connection. It requires
`voiceTranscription` to use the environment's model or `cloudVoiceTranscription`
to forward audio to the selected provider. Changing the grant or losing the
connection, permission, or required capability discards both the active recording
and any recording retained for retry. It never chooses a fallback destination.
The settings page's transcription test uses the same hook. The microphone loopback
test captures separately for local playback and sends nothing. The transport
refuses redirects so credentials and audio cannot follow one to another host.

Transcript cleanup requires its own grant, off by default.
It sends text, never audio, to the text generation model of the draft's
own environment, because that is where its credentials live.

A cloud destination binds both the forwarding environment and the named provider.
It uses a separate, batch-only endpoint: changing a server key cannot upgrade
an environment-local grant, and a cloud recording never uses the streaming
socket or falls back to another provider or the environment's native model.

OpenRouter routes to many upstreams, so its grant also names the exact model and
the model travels with every upload as a query parameter. The server accepts only
ids present in OpenRouter's public ZDR-eligible transcription catalog,
which it caches for ten minutes after a successful read;
router aliases such as `openrouter/auto` or `:nitro` fail schema validation before
that. Requests set `provider.zdr` and carry no `models` fallback list. OpenRouter
applies the account's safety-retention policy when choosing an endpoint. The catalog
holds no credential or consent state, which is why it may be cached while key
presence is read fresh on every request.

## Voice chat

Voice chat is a WebRTC call between the client and OpenAI's voice model, placed through
the undocumented ChatGPT route Codex's voice mode uses. The environment only answers the
client's SDP offer: it reads Codex's ChatGPT sign-in from `CODEX_HOME` (never writing or
refreshing it) and adds the [session](../../packages/shared/src/realtimeVoice.ts), so the
credential and the model-facing text stay server-owned while audio never crosses the T3
connection. That keeps remote and relay links free of audio and makes latency
independent of them. The route has no tools: the model delegates on its own, and it only
does so reliably with Codex's model name and its "backend" wording in the instructions.
The thread's opening state rides in the instructions too; sent as a message once the call
opens, it draws an unprompted reply.

Goals are summarized by the environment's text model through [the goals
service](../../apps/server/src/speech/goals.ts). It borrows the voice cleanup operation,
since a new provider operation would touch every provider driver, and a reply it cannot
parse falls back to a plain list in
[shared code](../../packages/shared/src/voiceGoals.ts) rather than failing. The client
sends one update at a time, in order, so a slow summary cannot overwrite a newer one.

An agent hangs up the call with `t3_voice_call_end`. The call lives in the client, so the
client keeps one question open to [the call control service](../../apps/server/src/speech/callControl.ts)
(a 25 second long poll, asked again until the call ends) and the tool answers it. A hang-up
that lands between two questions is held for a few seconds, and one with nobody listening reports
`hungUp: false` rather than waiting for a later call. A long poll avoids a new push channel
and its client permission surface; the tool's text is part of every agent's context, so
`agentContextBudget.json` grew by its size.

The call's control channel ends in the client, not on the server. The
[conversation](../../packages/client-runtime/src/voice-input/realtimeVoice.ts) turns the
model's delegations into the same thread commands the composer sends and feeds the
thread's messages back to the delegation they answer (progress quietly, the final result
spoken), so the server needs no call state, no socket to OpenAI,
and nothing to clean up when a client disappears. The call cannot outlive the client
anyway, because the client holds the microphone. A delegated request returns to the
model only when the thread is idle _and_ has shown the message that carried it; an idle
thread alone may simply not have received the message yet.

The [call](../../packages/client-runtime/src/voice-input/realtimeVoiceCall.ts) owns the
lifecycle, goals, mute and hang-up, so web and mobile differ only in the WebRTC transport
they plug in. Mobile's comes from `react-native-webrtc`, a native module: a JavaScript update
can reach a binary built without it, so the app hides voice chat when the module is absent.

## Server side

The [speech service](../../apps/server/src/speech/SpeechService.ts) runs
transcribe-cpp in a child process so a hung native call can be killed without
taking the server down; see [native.ts](../../apps/server/src/speech/native.ts)
for the packaging constraints (Node SEA, Electron ASAR). One native request runs
at a time. Batch uploads carry their options in the body framing defined in
[shared/speech.ts](../../packages/shared/src/speech.ts); streaming sends them in
the socket's first command. Model files and the selected model, hardware
placement, and unload timeout are environment state in server settings.
A model file from another app is installed as a symlink only after its SHA-256
matches a catalog entry, so the store never loads a file the catalog does not pin
and removing a model never deletes a file T3 Code did not download.

The Silero silence detector is optional. If its download fails, recordings use
raw audio during the retry cooldown so a detector outage cannot block dictation.
Explicitly installing a speech model also retries the detector without waiting.

## Cancellation and resource ownership

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results. On the server,
interrupting a batch request kills the worker process instead; the next request
reloads the model.
