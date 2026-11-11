import { useAtomValue } from "@effect/atom-react";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { environmentThreadDetails } from "../../state/threads";
import { stopVoiceChat, toggleVoiceChatMute, useVoiceChat } from "./realtimeVoiceCall";

const MAX_ROWS = 5;
const PANEL_MAX_WIDTH = 420;
const CHECK_ENTERING = FadeIn.duration(200).reduceMotion(ReduceMotion.System);

type ItemStatus = "working" | "done" | "failed" | "stopped" | "waiting";
interface PanelItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | null | undefined;
  readonly status: ItemStatus;
}

const STATUS_WORDS: Record<ItemStatus, string> = {
  working: "working",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  waiting: "not started",
};

function firstLine(text: string) {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

/** The live call, above every screen, until it ends. Hanging up leaves the agent working. */
export function VoiceChatPanelHost() {
  const call = useVoiceChat();
  if (call.status === "idle" || call.threadRef === null) return null;
  const panel = (
    <GestureHandlerRootView pointerEvents="box-none" style={{ position: "absolute", inset: 0 }}>
      <VoiceChatPanel threadRef={call.threadRef} />
    </GestureHandlerRootView>
  );
  return Platform.OS === "ios" ? <FullWindowOverlay>{panel}</FullWindowOverlay> : panel;
}

function VoiceChatPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const call = useVoiceChat();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [expanded, setExpanded] = useState(true);
  const offset = useSharedValue(0);
  const origin = useSharedValue(0);
  const lowest = useDerivedValue(
    () => Math.max(0, height - insets.top - insets.bottom - 160),
    [height, insets.top, insets.bottom],
  );
  // Drag the panel up or down to see what is behind it.
  const [drag] = useState(() =>
    Gesture.Pan()
      .activeOffsetY([-6, 6])
      .onStart(() => {
        origin.set(offset.get());
      })
      .onUpdate((event) => {
        offset.set(Math.min(Math.max(origin.get() + event.translationY, 0), lowest.get()));
      }),
  );
  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.get() }] }));
  const live = call.status === "live";
  const spoken = call.spoken?.text;
  const heard = call.heard?.text;

  return (
    <Animated.View
      className="absolute rounded-3xl border border-border bg-card shadow-lg shadow-black/15"
      style={[
        {
          top: insets.top + 8,
          left: Math.max(12, (width - PANEL_MAX_WIDTH) / 2),
          right: Math.max(12, (width - PANEL_MAX_WIDTH) / 2),
        },
        dragStyle,
      ]}
    >
      <GestureDetector gesture={drag}>
        <View className="flex-row items-center gap-2 py-2 pl-4 pr-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? "Hide call details" : "Show call details"}
            className="min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70"
            onPress={() => setExpanded((value) => !value)}
          >
            <View
              className={cn(
                "size-2 rounded-full",
                live
                  ? call.muted
                    ? "bg-foreground-muted"
                    : "bg-adaptive-emerald-500"
                  : "bg-warning",
              )}
            />
            <View className="min-w-0 flex-1">
              <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
                {live ? (call.muted ? "Voice chat · muted" : "Voice chat") : "Connecting…"}
              </Text>
              {!expanded && spoken ? (
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {spoken}
                </Text>
              ) : null}
            </View>
            <SymbolView
              name={expanded ? "chevron.up" : "chevron.down"}
              size={12}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
          <CallButton
            label={call.muted ? "Unmute" : "Mute"}
            icon={call.muted ? "mic.slash" : "mic"}
            selected={call.muted}
            disabled={!live}
            onPress={toggleVoiceChatMute}
          />
          <CallButton
            label="End voice chat"
            icon="phone.down.fill"
            danger
            onPress={stopVoiceChat}
          />
        </View>
      </GestureDetector>
      {expanded ? (
        <View className="gap-3 px-4 pb-4">
          <View className="gap-1" accessibilityLiveRegion="polite">
            <CaptionLine
              who="You"
              text={heard ?? null}
              live={call.heard?.live ?? false}
              empty={call.heard?.live ? "…" : "Say what you want done."}
            />
            <CaptionLine who="T3" text={spoken ?? null} live={false} empty="Waiting for you." />
          </View>
          <CallDetails threadRef={props.threadRef} />
        </View>
      ) : null}
    </Animated.View>
  );
}

function CallDetails(props: { readonly threadRef: ScopedThreadRef }) {
  const call = useVoiceChat();
  const turn = useAtomValue(environmentThreadDetails.turnSubagentsAtom(props.threadRef));
  const projection = useQuietThreadStructure(props.threadRef)?.projection ?? null;
  const steps =
    projection?.plans.findLast((plan) => plan.kind === "todo_list" && plan.status === "active") ??
    null;
  const agents: ReadonlyArray<PanelItem> =
    turn === null || !turn.latestTurn
      ? []
      : turn.subagents.map((subagent) => ({
          id: subagent.id,
          label: formatSubagentDisplayTitle(subagent.title ?? firstLine(subagent.prompt)),
          detail: subagent.progress,
          status:
            subagent.status === "completed"
              ? "done"
              : subagent.status === "failed"
                ? "failed"
                : subagent.status === "pending" ||
                    subagent.status === "running" ||
                    subagent.status === "waiting"
                  ? "working"
                  : "stopped",
        }));
  return (
    <>
      <ItemList
        title="Goals"
        items={call.goals.map((goal) => ({
          id: goal.id,
          label: goal.text,
          status:
            goal.status === "active" ? "working" : goal.status === "done" ? "done" : "stopped",
        }))}
      />
      {call.goals.length === 0 && call.requests.length > 0 ? (
        <Text className="text-xs text-foreground-muted">Working out your goals…</Text>
      ) : null}
      <ItemList title="Agents" items={agents} />
      <ItemList
        title="Steps"
        items={
          steps?.kind === "todo_list"
            ? steps.steps.map((step) => ({
                id: step.id,
                label: step.text,
                status:
                  step.status === "completed"
                    ? "done"
                    : step.status === "running"
                      ? "working"
                      : "waiting",
              }))
            : []
        }
      />
    </>
  );
}

function CaptionLine(props: {
  readonly who: string;
  readonly text: string | null;
  readonly live: boolean;
  readonly empty: string;
}) {
  return (
    <View className="flex-row gap-2">
      <Text className="w-8 text-xs text-foreground-muted">{props.who}</Text>
      <Text
        className={cn(
          "min-w-0 flex-1 text-xs",
          props.live || !props.text ? "text-foreground-muted" : "text-foreground",
        )}
        numberOfLines={3}
      >
        {props.text || props.empty}
      </Text>
    </View>
  );
}

function ItemList(props: { readonly title: string; readonly items: ReadonlyArray<PanelItem> }) {
  if (props.items.length === 0) return null;
  const hidden = Math.max(0, props.items.length - MAX_ROWS);
  return (
    <View className="gap-1">
      <Text className="font-t3-medium text-[11px] uppercase tracking-wide text-foreground-muted">
        {props.title}
      </Text>
      {props.items.slice(-MAX_ROWS).map((item) => (
        <View
          key={item.id}
          accessible
          accessibilityLabel={`${item.label}, ${STATUS_WORDS[item.status]}`}
          className="flex-row items-start gap-1.5"
        >
          <StatusMark status={item.status} />
          <View className="min-w-0 flex-1">
            <Text
              className={cn(
                "text-xs",
                item.status === "working" ? "text-foreground" : "text-foreground-muted",
              )}
              numberOfLines={1}
            >
              {item.label}
            </Text>
            {item.detail && item.status === "working" ? (
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                {item.detail}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
      {hidden > 0 ? (
        <Text className="text-[11px] text-foreground-muted">{hidden} earlier</Text>
      ) : null}
    </View>
  );
}

function StatusMark(props: { readonly status: ItemStatus }) {
  if (props.status === "done")
    return (
      <Animated.View
        entering={CHECK_ENTERING}
        className="mt-px size-3.5 items-center justify-center"
      >
        <SymbolView
          name="checkmark"
          size={11}
          weight="semibold"
          tintColorClassName="accent-adaptive-emerald-600"
        />
      </Animated.View>
    );
  return (
    <View className="mt-px size-3.5 items-center justify-center">
      <View
        className={cn(
          "size-1.5 rounded-full",
          props.status === "working" && "bg-primary",
          props.status === "waiting" && "border border-foreground-muted",
          props.status === "failed" && "bg-danger-foreground",
          props.status === "stopped" && "bg-foreground-muted",
        )}
      />
    </View>
  );
}

function CallButton(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly selected?: boolean;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={4}
      className="size-[40px] items-center justify-center active:opacity-70"
      style={{ opacity: props.disabled ? 0.4 : 1 }}
      onPress={props.onPress}
    >
      <View
        className={cn(
          "size-[34px] items-center justify-center rounded-full",
          props.danger ? "bg-danger" : props.selected ? "bg-foreground" : "bg-subtle",
        )}
      >
        <SymbolView
          name={props.icon}
          size={15}
          weight="semibold"
          tintColorClassName={
            props.danger
              ? "accent-danger-foreground"
              : props.selected
                ? "accent-screen"
                : "accent-icon"
          }
          type="monochrome"
        />
      </View>
    </Pressable>
  );
}
