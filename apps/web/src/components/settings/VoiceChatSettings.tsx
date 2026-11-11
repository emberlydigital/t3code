import { getCloudSpeechKeys, setCloudSpeechKey } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  RealtimeVoiceName,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { PlayIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useCloudRead } from "./CloudVoiceConfiguration";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const isApiKey = Schema.is(CloudSpeechApiKey);

function voiceLabel(voice: RealtimeVoiceName) {
  return voice[0]!.toUpperCase() + voice.slice(1);
}

/** Plays a short recorded sample of a voice, one at a time. It needs no key or connection. */
function useVoicePreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<RealtimeVoiceName | null>(null);

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  };
  const play = (voice: RealtimeVoiceName) => {
    audioRef.current?.pause();
    const audio = new Audio(
      `${import.meta.env.BASE_URL.replace(/\/$/, "")}/voice-previews/${voice}.mp3`,
    );
    audioRef.current = audio;
    setPlaying(voice);
    const finish = () => {
      if (audioRef.current !== audio) return;
      audioRef.current = null;
      setPlaying(null);
    };
    audio.addEventListener("ended", finish);
    audio.addEventListener("error", finish);
    audio.play().catch(finish);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- silences a sample still playing when the page closes
  useEffect(
    () => () => {
      audioRef.current?.pause();
    },
    [],
  );
  return { playing, play, stop };
}

/** The OpenAI key voice chat calls with on one environment. Cloud dictation shares it. */
function VoiceChatKeyRow({
  environment,
  showLabel,
}: {
  environment: EnvironmentPresentation;
  showLabel: boolean;
}) {
  const id = environment.environmentId;
  const prepared = Option.getOrNull(usePreparedConnection(id));
  const canUse = useEnvironmentScope(id, AuthOrchestrationOperateScope);
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const [presence, refresh] = useCloudRead(canUse ? prepared : null, getCloudSpeechKeys);
  const saved = AsyncResult.isSuccess(presence) ? presence.value?.openai : undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = draft.trim();

  const write = async (value: string | null) => {
    if (prepared === null || busy) return;
    setError("");
    setBusy(true);
    try {
      await runEnvironmentSpeech(setCloudSpeechKey(prepared, "openai", value));
      refresh();
      setDraft("");
      setEditing(false);
    } catch {
      setError("Couldn’t save this change. Check your connection and try again.");
    }
    setBusy(false);
  };

  const status = saved === undefined ? "Checking…" : saved ? "Saved" : "Not set";

  return (
    <SettingsRow
      {...searchableSetting("voice-chat-key")}
      title={showLabel ? `OpenAI API key · ${environment.label}` : "OpenAI API key"}
      description={
        canManage
          ? "Voice chat runs on your OpenAI account. This key is only used when you choose OpenAI; dictation keeps using what you picked under Transcription."
          : `Ask an administrator on ${environment.label} to add an OpenAI key.`
      }
      control={
        editing ? null : (
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-muted-foreground text-xs">{status}</span>
            {canManage && saved !== undefined ? (
              <>
                <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                  {saved ? "Replace" : "Add key"}
                </Button>
                {saved ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost-destructive"
                    disabled={busy}
                    onClick={() => void write(null)}
                  >
                    Remove
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        )
      }
    >
      {editing ? (
        <form
          className="flex flex-col gap-2 pb-3.5 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (isApiKey(key)) void write(key);
          }}
        >
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
          <div className="flex shrink-0 justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft("");
                setError("");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !isApiKey(key)}>
              Save
            </Button>
          </div>
        </form>
      ) : null}
      {error ? <p className="pb-3 text-destructive text-xs">{error}</p> : null}
    </SettingsRow>
  );
}

export function VoiceChatSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const voice = useClientSettings((settings) => settings.voiceChatVoice);
  const preview = useVoicePreview();
  const supported = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.realtimeVoice === true,
  );
  if (supported.length === 0) return null;

  return (
    <SettingsSection id="voice-chat" title="Voice chat">
      {supported.map((environment) => (
        <VoiceChatKeyRow
          key={environment.environmentId}
          environment={environment}
          showLabel={supported.length > 1}
        />
      ))}
      <SettingsRow
        {...searchableSetting("voice-chat-voice")}
        title="Voice"
        description="How voice chat sounds. Applies from your next call."
        control={
          <div className="flex items-center gap-1.5">
            <Select
              value={voice}
              onValueChange={(value) => {
                if (!value) return;
                void updateClientSettings({ voiceChatVoice: value as RealtimeVoiceName });
                preview.play(value as RealtimeVoiceName);
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
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={preview.playing === voice ? "Stop preview" : "Preview voice"}
              title={preview.playing === voice ? "Stop preview" : "Preview voice"}
              onClick={() => (preview.playing === voice ? preview.stop() : preview.play(voice))}
            >
              {preview.playing === voice ? <SquareIcon /> : <PlayIcon />}
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}
