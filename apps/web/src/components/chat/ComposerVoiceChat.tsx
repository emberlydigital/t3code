import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { setCloudSpeechKey } from "@t3tools/client-runtime/voice-input";
import {
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AudioLinesIcon, PhoneOffIcon } from "lucide-react";
import { useState } from "react";

import {
  startRealtimeVoice,
  stopRealtimeVoice,
  useRealtimeVoiceStore,
} from "../../speech/realtimeVoiceSession";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { useEnvironment } from "../../state/environments";
import { readPreparedConnection, useEnvironmentScope } from "../../state/session";
import { SecretInput } from "../settings/SecretInput";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const isApiKey = Schema.is(CloudSpeechApiKey);

/** Asks for the OpenAI key voice chat needs, saves it on the environment, then starts the call. */
function VoiceChatKeyDialog(props: {
  threadRef: ScopedThreadRef;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const environment = useEnvironment(props.threadRef.environmentId);
  const canSave = useEnvironmentScope(props.threadRef.environmentId, AuthSettingsWriteScope);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = draft.trim();

  const save = async () => {
    const prepared = readPreparedConnection(props.threadRef.environmentId);
    if (prepared === null || busy || !isApiKey(key)) return;
    setError("");
    setBusy(true);
    try {
      await runEnvironmentSpeech(setCloudSpeechKey(prepared, "openai", key));
      setDraft("");
      props.onOpenChange(false);
      void startRealtimeVoice(props.threadRef);
    } catch {
      setError("Couldn’t save the key. Check your connection and try again.");
    }
    setBusy(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add your OpenAI key</DialogTitle>
            <DialogDescription>
              {canSave
                ? `Voice chat runs on your OpenAI account. The key is saved on ${environment?.label ?? "this environment"}.`
                : `Ask an administrator on ${environment?.label ?? "this environment"} to add an OpenAI key.`}
            </DialogDescription>
          </DialogHeader>
          {canSave ? (
            <DialogPanel>
              <SecretInput
                name="key"
                aria-label="OpenAI API key"
                autoFocus
                placeholder="sk-…"
                value={draft}
                disabled={busy}
                maxLength={4096}
                onChange={(event) => setDraft(event.target.value)}
              />
              {error ? <p className="mt-2 text-destructive text-xs">{error}</p> : null}
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            {canSave ? (
              <Button type="submit" disabled={busy || !isApiKey(key)}>
                Save and start
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Starts a live voice call about a thread, and shows the call while it is open. */
export function ComposerVoiceChat(props: { threadRef: ScopedThreadRef | null; disabled: boolean }) {
  const { threadRef } = props;
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const status = useRealtimeVoiceStore((state) =>
    state.threadKey === threadKey ? state.status : "idle",
  );
  const [keyNeeded, setKeyNeeded] = useState(false);
  if (
    threadRef === null ||
    environment?.serverConfig?.environment.capabilities.realtimeVoice !== true
  )
    return null;

  if (status === "idle") {
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Start voice chat"
                disabled={props.disabled}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() =>
                  void startRealtimeVoice(threadRef).then((outcome) => {
                    if (outcome === "missing-key") setKeyNeeded(true);
                  })
                }
              >
                <AudioLinesIcon />
              </Button>
            }
          />
          <TooltipPopup side="top">Start voice chat</TooltipPopup>
        </Tooltip>
        <VoiceChatKeyDialog threadRef={threadRef} open={keyNeeded} onOpenChange={setKeyNeeded} />
      </>
    );
  }

  // The floating panel shows the call; here the button only says it is on and ends it.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="destructive"
            aria-label="End voice chat"
            onPointerDown={(event) => event.preventDefault()}
            onClick={stopRealtimeVoice}
          >
            <PhoneOffIcon />
          </Button>
        }
      />
      <TooltipPopup side="top">End voice chat</TooltipPopup>
    </Tooltip>
  );
}
