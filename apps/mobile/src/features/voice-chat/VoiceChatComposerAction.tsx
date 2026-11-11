import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { VoiceActionButton } from "../voice-input/ComposerDictationControl";
import {
  startVoiceChat,
  stopVoiceChat,
  useVoiceChat,
  voiceChatConnectionAtom,
} from "./realtimeVoiceCall";

/** Starts a voice call about the thread, or ends the one already open on it. */
export function VoiceChatComposerAction(props: {
  readonly size?: "regular" | "large";
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const available = useAtomValue(voiceChatConnectionAtom(props.environmentId)) !== null;
  const call = useVoiceChat();
  const onThisThread =
    call.status !== "idle" &&
    call.threadKey === scopedThreadKey(props.environmentId, props.threadId);
  if (!available && !onThisThread) return null;
  return (
    <VoiceActionButton
      size={props.size}
      accessibilityLabel={onThisThread ? "End voice chat" : "Start voice chat"}
      icon={onThisThread ? "phone.down.fill" : "waveform"}
      loading={onThisThread && call.status === "connecting"}
      onPress={() =>
        onThisThread
          ? stopVoiceChat()
          : void startVoiceChat({ environmentId: props.environmentId, threadId: props.threadId })
      }
    />
  );
}
