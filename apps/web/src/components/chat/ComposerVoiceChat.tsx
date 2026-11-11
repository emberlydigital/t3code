import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AudioLinesIcon, PhoneOffIcon } from "lucide-react";

import {
  startRealtimeVoice,
  stopRealtimeVoice,
  useRealtimeVoiceStore,
} from "../../speech/realtimeVoiceSession";
import { useEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Starts a live voice call about a thread, or ends the call open on it. */
export function ComposerVoiceChat(props: { threadRef: ScopedThreadRef | null; disabled: boolean }) {
  const { threadRef } = props;
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const status = useRealtimeVoiceStore((state) =>
    state.threadKey === threadKey ? state.status : "idle",
  );
  if (
    threadRef === null ||
    environment?.serverConfig?.environment.capabilities.realtimeVoice !== true
  )
    return null;

  if (status === "idle") {
    return (
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
              onClick={() => void startRealtimeVoice(threadRef)}
            >
              <AudioLinesIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">Start voice chat</TooltipPopup>
      </Tooltip>
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
