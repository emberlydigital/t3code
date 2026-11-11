import { RealtimeVoiceName } from "@t3tools/contracts";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { resolveVoiceChatVoice } from "../../speech/realtimeVoiceSession";
import type { EnvironmentPresentation } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function voiceLabel(voice: RealtimeVoiceName) {
  return voice[0]!.toUpperCase() + voice.slice(1);
}

export function VoiceChatSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const voice = resolveVoiceChatVoice(useClientSettings((settings) => settings.voiceChatVoice));
  const supported = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.realtimeVoice === true,
  );
  if (supported.length === 0) return null;
  const machines = supported.map((environment) => environment.label).join(", ");

  return (
    <SettingsSection id="voice-chat" title="Voice chat">
      <SettingsRow
        {...searchableSetting("voice-chat-account")}
        title="ChatGPT account"
        description={`Voice chat runs on the ChatGPT account Codex is signed in with on ${machines}. Sign in to Codex with ChatGPT there if a call will not start. This uses your ChatGPT plan's voice allowance, not API billing.`}
      />
      <SettingsRow
        {...searchableSetting("voice-chat-voice")}
        title="Voice"
        description="How voice chat sounds. Applies from your next call."
        control={
          <Select
            value={voice}
            onValueChange={(value) => {
              if (value) void updateClientSettings({ voiceChatVoice: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Voice chat voice" className="max-w-48">
              <SelectValue>{voiceLabel(voice)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {RealtimeVoiceName.literals.map((name) => (
                <SelectItem key={name} value={name}>
                  {voiceLabel(name)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
