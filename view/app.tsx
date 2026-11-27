// The window: the frame, the tab bar, the switches, a tab's body, the key line and the foot, drawn for the
// layout its width and seat call for.
import type { EngineInterface, RenderElement, RenderInput } from "claude-code";
import type { TabId } from "../core/args.ts";
import type { Settings } from "../core/settings.ts";
import type { Span } from "../core/summary.ts";
import { readSession } from "../engine/session-view.ts";
import { attempt, openWindow, readChart, readFoot, readView, setMachines, setMore, setRepoOnly, setSpan, showTab } from "../engine/window.ts";
import { drawInfoRow } from "./desktop-row.tsx";
import { drawFold } from "./fold.tsx";
import { drawFoot } from "./foot.tsx";
import { readLive } from "../engine/live.ts";
import { glanceLines, moneyOf, windowData } from "./data.ts";
import type { WindowData } from "./data.ts";
import { layoutOf } from "./layout.ts";
import { ESC_WORDS, hasRepoSwitch, HOW_TO_FOCUS, KEYS_ACTIVE, keyLine, keyLineText, spansOf, TABS } from "./keys.ts";
import type { KeyCtx } from "./keys.ts";
import { drawSession } from "./tabs/session.tsx";
import { tableOf } from "./table.ts";
import type { Table } from "./table.ts";
import { SEP } from "./theme.ts";

/** Everything a drawing reads, built from the atoms and the clock. */
async function loadData($: EngineInterface, settings: Pick<Settings, "money" | "decimals">): Promise<WindowData> {
  const [live, foot, chart, now] = await Promise.all([readLive($), readFoot($), readChart($), $.clock.now()]);
  return windowData({ live, foot, chart, settings, now });
}

const SPAN_LABEL: Record<Span, string> = { session: "Session", "24h": "24 hours", "30d": "30 days" };

// Until each tab has its own body: one dim line saying what it will hold.
const PLACEHOLDER: Record<Exclude<TabId, "session">, string> = {
  usage: "Tokens and cost by model, agent and tool.",
  context: "What fills the context window.",
  history: "Spend over the last 30 days.",
  hints: "Ways to spend less.",
  help: "Keys, prices and settings.",
};

/** The tab shown when the view holds a span the tab has no switch for (Hints has no session span). */
export function spanFor(tab: TabId, span: Span): Span {
  const spans = spansOf(tab);
  return spans.length === 0 || spans.includes(span) ? span : (spans[spans.length - 1] as Span);
}

type Choice = { key: string; label: string; isChosen: boolean; onPress: () => void };

// One labelled row of choices: the chosen one is the primary button, and the next one carries the switch's key.
function switchRow(t: Table, title: string, hotkey: string, choices: Choice[]): RenderElement {
  const { Box, Text, Button } = t;
  const at = Math.max(0, choices.findIndex((c) => c.isChosen));
  const next = choices.length > 1 ? (at + 1) % choices.length : -1;
  return (
    <Box key={`switch-${title.toLowerCase()}`} flexDirection="row" columnGap={1} flexWrap="wrap">
      <Text dimColor>{title}</Text>
      {choices.map((c, i) => (
        <Button key={c.key} label={c.label} {...(i === next && { hotkey })} {...(c.isChosen ? { variant: "primary" as const } : { dimColor: true })} onPress={c.onPress}>
          {c.label}
        </Button>
      ))}
    </Box>
  );
}

const rule = (t: Table, cols: number): RenderElement => {
  const { Text } = t;
  return <Text dimColor>{"\u{2500}".repeat(Math.max(0, cols))}</Text>;
};

function drawShort(t: Table, d: WindowData, cols: number, isFocused: boolean, isFullscreen: boolean): RenderElement {
  const { Box, Text } = t;
  const lines = glanceLines(d, cols);
  const note = isFullscreen ? "widen the terminal to dock the tabs" : "a taller frame, or /tui fullscreen, shows the tabs";
  return (
    <Box key="short" flexDirection="column">
      {lines.map((line, i) => (
        <Text key={`short-${i}`} {...(i === 0 ? { weight: "bold" } : {})} wrap="truncate-end">
          {line}
        </Text>
      ))}
      {t.hasKeys && (
        <Text dimColor wrap="truncate-end">
          {`${isFocused ? `${KEYS_ACTIVE}${SEP}${ESC_WORDS}` : HOW_TO_FOCUS}${SEP}${note}`}
        </Text>
      )}
    </Box>
  );
}

// Under 40 columns: a card with the cost, the chart, the hint and a short foot.
function drawCard(t: Table, d: WindowData, cols: number): RenderElement {
  const { Box, Text } = t;
  return (
    <Box key="card" flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text weight="bold">{moneyOf(d, d.costUsd)}</Text>
        <Text dimColor>session</Text>
      </Box>
      {d.chart !== null && <Text dimColor>{`8h ${d.chart}`}</Text>}
      {d.hint !== null && (
        <Text wrap="truncate-end">{`\u{25b2} ${d.hint.found}`}</Text>
      )}
      {rule(t, cols)}
      {drawFoot(t, d, cols)}
    </Box>
  );
}

/** The `Pane` drawing. `settings` is read at each draw, so a changed option shows at once. */
export async function drawPane($: EngineInterface, e: RenderInput<"Pane">, settings: Settings): Promise<RenderElement> {
  const t = tableOf($, e);
  const { Box, Text, Button } = t;
  const [view, d] = await Promise.all([readView($), loadData($, settings)]);
  const cols = e.props.bodyColumns;
  const rows = e.props.scroll.bodyRows;
  const isFullscreen = e.viewport?.isFullscreen === true;
  const placement = e.props.placement === "inline" ? "inline" : "dock";
  // A widget (the desktop's small form of a minimised pane) draws what reads at a glance, like a short inline frame.
  const layout = e.props.placement === "widget" ? "short" : layoutOf(cols, rows, placement, { isFullscreen });
  if (layout === "short") return drawShort(t, d, cols, e.props.isFocused, isFullscreen);
  if (layout === "compact") return drawCard(t, d, cols);

  const isNarrow = layout === "narrow";
  const tab = view.tab;
  const span = spanFor(tab, view.span);
  const ctx: KeyCtx = { machines: settings.syncDir !== "" };

  const tabBar = (
    <Box key="tabs" flexDirection="row" columnGap={1} flexWrap="wrap">
      {TABS.map((s) => (
        <Button
          key={`tab-${s.tab}`}
          label={isNarrow ? s.short : s.label}
          hotkey={s.hotkey}
          {...(t.hasKeys && !isNarrow && { plain: true as const })}
          {...(s.tab === tab ? { variant: "primary" as const } : { dimColor: true })}
          onPress={() => attempt($, () => showTab($, s.tab))}
        >
          {isNarrow ? s.short : s.label}
        </Button>
      ))}
    </Box>
  );

  const switches: RenderElement[] = [];
  const spans = spansOf(tab);
  if (spans.length > 0) {
    switches.push(switchRow(t, "Span", "s", spans.map((s) => ({ key: `span-${s}`, label: SPAN_LABEL[s], isChosen: s === span, onPress: () => attempt($, () => setSpan($, s)) }))));
  }
  if (hasRepoSwitch(tab)) {
    switches.push(
      switchRow(t, "Repos", "r", [
        { key: "repo-all", label: "All", isChosen: !view.repoOnly, onPress: () => attempt($, () => setRepoOnly($, false)) },
        { key: "repo-only", label: "Current repo", isChosen: view.repoOnly, onPress: () => attempt($, () => setRepoOnly($, true)) },
      ]),
    );
  }
  if (ctx.machines === true && (tab === "usage" || tab === "history" || tab === "hints")) {
    switches.push(
      switchRow(t, "Machines", "t", [
        { key: "machines-this", label: "This machine", isChosen: view.machines === "this", onPress: () => attempt($, () => setMachines($, "this")) },
        { key: "machines-all", label: "All computers", isChosen: view.machines === "all", onPress: () => attempt($, () => setMachines($, "all")) },
      ]),
    );
  }

  let tabRows: RenderElement[];
  if (tab === "session") {
    const [live, data] = await Promise.all([readLive($), readSession($)]);
    const drawn = drawSession(t, {
      d,
      live,
      data,
      cols,
      more: view.more,
      onMore: (more) => attempt($, () => setMore($, more)),
      // A token row drills to Usage, on this session.
      onUsage: () =>
        attempt($, async () => {
          await setSpan($, "session");
          await showTab($, "usage");
        }),
    });
    tabRows = drawn.rows;
    Object.assign(ctx, drawn.ctx);
  } else {
    tabRows = [
      <Text key="placeholder" dimColor wrap="truncate-end">
        {PLACEHOLDER[tab]}
      </Text>,
    ];
  }
  const body = (
    <Box key={`body-${tab}`} flexDirection="column">
      {tabRows}
    </Box>
  );
  const keys = t.hasKeys ? (
    <Text key="keys" dimColor wrap="truncate-end">
      {keyLineText(cols, e.props.isFocused, keyLine(tab, ctx))}
    </Text>
  ) : null;
  const head = [tabBar, ...switches, ...(switches.length > 0 ? [rule(t, cols)] : [])];
  const foots = [...(keys === null ? [] : [keys]), rule(t, cols), ...drawFoot(t, d, cols)];

  if (placement === "dock") {
    // Docked, the tree is the dock's height: the foot stays at the bottom whatever the tab holds.
    return (
      <Box key="window" flexDirection="column" height={rows}>
        <Box flexDirection="column" flexShrink={0}>
          {head}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {body}
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          {foots}
        </Box>
      </Box>
    );
  }
  // Inline, the frame is as tall as its tree and the engine scrolls it whole. Until the first action a tip says docking needs fullscreen.
  const showTip = !view.hasTipped && !isFullscreen;
  return (
    <Box key="window" flexDirection="column">
      {showTip && (
        <Box key="tip">
          <Text dimColor wrap="truncate-end">
            docks as a sidebar only in fullscreen: /tui fullscreen
          </Text>
        </Box>
      )}
      {head}
      {body}
      {foots}
    </Box>
  );
}

/**
 * The `AbovePrompt` band: on the desktop app with `desktopRow` on, the info row, open or folded; else the folded
 * line while the window is folded. VS Code has no band, so nothing of it is drawn there. Anything else is the
 * band beneath.
 */
export async function drawBand(
  $: EngineInterface,
  e: RenderInput<"AbovePrompt">,
  next: (e: RenderInput<"AbovePrompt">) => Promise<RenderElement>,
  settings: Settings,
): Promise<RenderElement> {
  if (e.props.hasSurvey || (e.surface !== "terminal" && e.surface !== "desktop")) return next(e);
  const onOpen = () => attempt($, () => openWindow($, settings, { asked: true }));
  if (e.surface === "desktop" && settings.desktopRow) return drawInfoRow($, e, await loadData($, settings), onOpen);
  if ((await readView($)).mode !== "folded") return next(e);
  return drawFold($, e, await loadData($, settings), onOpen);
}
