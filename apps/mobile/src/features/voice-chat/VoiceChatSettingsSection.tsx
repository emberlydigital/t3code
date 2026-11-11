import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_REALTIME_VOICE, RealtimeVoiceName } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "../settings/components/SettingsSection";
import { hasRealtimeVoice } from "./realtimeVoiceCall";

const capitalize = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The voice live calls speak with. Separate from dictation, which never leaves its own route. */
export function VoiceChatSettingsSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  if (!hasRealtimeVoice) return null;
  const selected = AsyncResult.isSuccess(preferences)
    ? (preferences.value.voiceChatVoice ?? DEFAULT_REALTIME_VOICE)
    : DEFAULT_REALTIME_VOICE;
  return (
    <SettingsSection
      title="Voice chat"
      footer="Live voice chat runs on the ChatGPT account signed in to Codex on the environment."
    >
      {RealtimeVoiceName.literals.map((voice, index) => (
        <ListChoiceRow
          key={voice}
          label={capitalize(voice)}
          selected={selected === voice}
          separated={index > 0}
          disabled={!AsyncResult.isSuccess(preferences)}
          onPress={() => save({ voiceChatVoice: voice })}
        />
      ))}
    </SettingsSection>
  );
}
