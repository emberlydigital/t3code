import { useAtomValue } from "@effect/atom-react";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AudioLinesIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  PictureInPicture2Icon,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { registerCommands } from "../../shortcuts/dispatcher";
import {
  stopRealtimeVoice,
  toggleRealtimeVoiceMute,
  useRealtimeVoiceStore,
} from "../../speech/realtimeVoiceSession";
import { useQuietThreadProjection } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const EDGE_GAP = 12;
const MAX_ROWS = 5;

type ItemStatus = "working" | "done" | "failed" | "stopped" | "waiting";

interface PanelItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly status: ItemStatus;
}

registerCommands(
  {
    "voiceChat.toggleMute": (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleRealtimeVoiceMute();
    },
  },
  { when: () => useRealtimeVoiceStore.getState().status !== "idle" },
);

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

function documentPictureInPicture() {
  return (window as { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture;
}

/** The pop-out is a bare document, so it gets the app's styles and follows its theme. */
function mirrorDocument(target: Document) {
  for (const sheet of document.querySelectorAll('link[rel="stylesheet"], style'))
    target.head.appendChild(sheet.cloneNode(true));
  const copyRootAttributes = () => {
    for (const { name, value } of document.documentElement.attributes)
      target.documentElement.setAttribute(name, value);
    target.body.className = document.body.className;
  };
  copyRootAttributes();
  const observer = new MutationObserver(copyRootAttributes);
  observer.observe(document.documentElement, { attributes: true });
  target.defaultView?.addEventListener("pagehide", () => observer.disconnect(), { once: true });
}

/**
 * Moves the panel into a small always-on-top window that floats over other apps. The call, the
 * microphone and the audio stay in this window; only what is drawn moves.
 */
function usePopOut(callOpen: boolean) {
  const [popped, setPopped] = useState<Window | null>(null);
  const supported = documentPictureInPicture() !== undefined;

  const popOut = async () => {
    const api = documentPictureInPicture();
    if (api === undefined || popped !== null) return;
    try {
      const next = await api.requestWindow({ width: 340, height: 440 });
      mirrorDocument(next.document);
      next.addEventListener("pagehide", () => setPopped(null), { once: true });
      setPopped(next);
    } catch {
      // The browser refused the window (no recent click, or pop-outs are off); the panel stays in the app.
    }
  };
  const popIn = () => popped?.close();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the separate window when the call ends or the page unmounts
  useEffect(() => {
    if (!callOpen) popped?.close();
  }, [callOpen, popped]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a separate window has its own key events, which the page's shortcut listener never sees
  useEffect(() => () => popped?.close(), [popped]);

  return { popped, supported, popOut, popIn };
}

function firstLine(text: string) {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

function StatusMark({ status }: { status: ItemStatus }) {
  if (status === "done")
    return (
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0 text-success">
        <path
          d="M3.5 8.5 6.5 11.5 12.5 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="16"
          className="motion-safe:animate-check-draw"
        />
      </svg>
    );
  return (
    <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "working" && "bg-primary motion-safe:animate-status-pulse",
          status === "waiting" && "border border-muted-foreground/60",
          status === "failed" && "bg-destructive",
          status === "stopped" && "bg-muted-foreground/60",
        )}
      />
    </span>
  );
}

const STATUS_WORDS: Record<ItemStatus, string> = {
  working: "working",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  waiting: "not started",
};

function ItemList({ title, items }: { title: string; items: ReadonlyArray<PanelItem> }) {
  if (items.length === 0) return null;
  const hidden = Math.max(0, items.length - MAX_ROWS);
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-3xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="flex flex-col gap-1">
        {items.slice(-MAX_ROWS).map((item) => (
          <li key={item.id} className="flex min-w-0 items-start gap-1.5 text-xs">
            <span className="mt-px">
              <StatusMark status={item.status} />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate",
                  item.status !== "working" && "text-muted-foreground",
                )}
              >
                {item.label}
                <span className="sr-only">, {STATUS_WORDS[item.status]}</span>
              </span>
              {item.detail && item.status === "working" ? (
                <span className="block truncate text-muted-foreground">{item.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? <p className="text-3xs text-muted-foreground">{hidden} earlier</p> : null}
    </section>
  );
}

function CaptionLine(props: { who: string; text: string | null; live: boolean; empty: string }) {
  return (
    <p className="flex min-w-0 gap-2 text-xs">
      <span className="w-8 shrink-0 text-muted-foreground">{props.who}</span>
      <span
        className={cn(
          "line-clamp-3 min-w-0 flex-1",
          (props.live || !props.text) && "text-muted-foreground",
        )}
      >
        {props.text || props.empty}
      </span>
    </p>
  );
}

function PanelBody({ threadRef }: { threadRef: ScopedThreadRef }) {
  const heard = useRealtimeVoiceStore((state) => state.heard);
  const spoken = useRealtimeVoiceStore((state) => state.spoken);
  const requests = useRealtimeVoiceStore((state) => state.requests);
  const turn = useAtomValue(environmentThreadDetails.turnSubagentsAtom(threadRef));
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
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
    <div className="flex flex-col gap-3 px-3 pb-3">
      <div className="flex flex-col gap-1" aria-live="polite">
        <CaptionLine
          who="You"
          text={heard?.text ?? null}
          live={heard?.live ?? false}
          empty={heard?.live ? "…" : "Say what you want done."}
        />
        <CaptionLine who="T3" text={spoken?.text ?? null} live={false} empty="Waiting for you." />
      </div>
      <ItemList
        title="Asked by voice"
        items={requests.map((request) => ({
          id: request.id,
          label: firstLine(request.prompt),
          status: request.status,
        }))}
      />
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
    </div>
  );
}

function HeaderButton(props: {
  label: string;
  tooltip: ReactNode;
  variant: "ghost" | "destructive";
  pressed?: boolean;
  /** In the pop-out window, where the page's tooltips cannot appear. */
  native?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  if (props.native)
    return (
      <Button
        type="button"
        size="icon-sm-pill"
        variant={props.variant}
        aria-label={props.label}
        aria-pressed={props.pressed}
        title={typeof props.tooltip === "string" ? props.tooltip : props.label}
        onClick={props.onClick}
      >
        {props.children}
      </Button>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm-pill"
            variant={props.variant}
            aria-label={props.label}
            aria-pressed={props.pressed}
            // The header drags the panel; its buttons must not start a drag.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={props.onClick}
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The live voice call, floating above every route so it stays reachable while the user moves
 * between threads, or popped out into its own window over other apps. Ending the call here only
 * hangs up; the thread's agent keeps working.
 */
export function VoiceChatPanel() {
  const status = useRealtimeVoiceStore((state) => state.status);
  const threadRef = useRealtimeVoiceStore((state) => state.threadRef);
  const activity = useRealtimeVoiceStore((state) => state.activity);
  const muted = useRealtimeVoiceStore((state) => state.muted);
  const working = useRealtimeVoiceStore((state) =>
    state.requests.some((request) => request.status === "working"),
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const title = useQuietThreadProjection(threadRef)?.projection.thread.title ?? "Voice chat";
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  // Null keeps the resting corner; a drag pins the panel where it was dropped.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const callOpen = status !== "idle" && threadRef !== null;
  const { popped, supported, popOut, popIn } = usePopOut(callOpen);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the pop-out window has its own key events, which the page's shortcut listener never sees
  useEffect(() => {
    if (popped === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || resolveShortcutCommand(event, keybindings) !== "voiceChat.toggleMute")
        return;
      event.preventDefault();
      toggleRealtimeVoiceMute();
    };
    popped.addEventListener("keydown", onKeyDown);
    return () => popped.removeEventListener("keydown", onKeyDown);
  }, [popped, keybindings]);

  if (!callOpen) return null;

  const muteShortcut = shortcutLabelForCommand(keybindings, "voiceChat.toggleMute");
  const label =
    status === "connecting"
      ? "Connecting…"
      : muted
        ? "Muted"
        : activity === "listening"
          ? "Listening"
          : activity === "speaking"
            ? "Speaking"
            : working
              ? "Working"
              : "Ready";

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (event.button !== 0 || panel === null) return;
    const box = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = dragRef.current;
    const panel = panelRef.current;
    if (gesture?.pointerId !== event.pointerId || panel === null) return;
    const maxX = window.innerWidth - panel.offsetWidth - EDGE_GAP;
    const maxY = window.innerHeight - panel.offsetHeight - EDGE_GAP;
    setPosition({
      x: Math.max(EDGE_GAP, Math.min(maxX, event.clientX - gesture.offsetX)),
      y: Math.max(EDGE_GAP, Math.min(maxY, event.clientY - gesture.offsetY)),
    });
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const inWindow = popped !== null;
  const header = (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 select-none",
        !inWindow && "cursor-grab touch-none active:cursor-grabbing",
      )}
      {...(inWindow
        ? {}
        : {
            onPointerDown: beginDrag,
            onPointerMove: drag,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
          })}
    >
      <AudioLinesIcon
        aria-hidden
        className={cn(
          "size-4 shrink-0",
          muted || status === "connecting" ? "text-muted-foreground" : "text-primary",
          activity !== "idle" && !muted && "motion-safe:animate-status-pulse",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium" role="status">
          {label}
        </p>
        <button
          type="button"
          className="block max-w-full truncate text-left text-3xs text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(threadRef),
            })
          }
        >
          {title}
        </button>
      </div>
      {supported ? (
        <HeaderButton
          label={inWindow ? "Return to app" : "Pop out"}
          tooltip={inWindow ? "Return to the app" : "Pop out to float over other apps"}
          variant="ghost"
          native={inWindow}
          onClick={inWindow ? popIn : () => void popOut()}
        >
          <PictureInPicture2Icon />
        </HeaderButton>
      ) : null}
      <HeaderButton
        label={muted ? "Unmute microphone" : "Mute microphone"}
        tooltip={`${muted ? "Unmute" : "Mute"}${muteShortcut ? ` (${muteShortcut})` : ""}`}
        variant="ghost"
        pressed={muted}
        native={inWindow}
        onClick={toggleRealtimeVoiceMute}
      >
        {muted ? <MicOffIcon /> : <MicIcon />}
      </HeaderButton>
      <HeaderButton
        label="End voice chat"
        tooltip={working ? "End voice chat. The agent keeps working." : "End voice chat"}
        variant="destructive"
        native={inWindow}
        onClick={stopRealtimeVoice}
      >
        <PhoneOffIcon />
      </HeaderButton>
    </div>
  );

  if (popped !== null)
    return createPortal(
      <div
        role="region"
        aria-label="Voice chat"
        data-slot="voice-chat-panel"
        className="flex h-screen flex-col bg-popover text-popover-foreground"
      >
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PanelBody threadRef={threadRef} />
        </div>
      </div>,
      popped.document.body,
    );

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label="Voice chat"
      data-slot="voice-chat-panel"
      className={cn(
        "fixed z-[47] flex max-h-[70vh] w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lg",
        position === null && "right-4 bottom-28",
      )}
      style={position === null ? undefined : { left: position.x, top: position.y }}
    >
      {header}
      <div className="min-h-0 overflow-y-auto">
        <PanelBody threadRef={threadRef} />
      </div>
    </div>
  );
}
