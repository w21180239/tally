// The window: the frame, the tab bar, the switches, a tab's body, the key line and the foot, drawn for the
// layout its width and seat call for.
import type { EngineInterface, RenderElement, RenderInput } from "claude-code";
import type { TabId } from "../core/args.ts";
import type { Settings } from "../core/settings.ts";
import type { Span } from "../core/summary.ts";
import { readAgentStates, readContext, wantContext } from "../engine/context-view.ts";
import { readSession } from "../engine/session-view.ts";
import { loadTranscript, needsTranscript, readTranscripts } from "../engine/subagent-transcript.ts";
import { readHistory, readScanView, wantHistory } from "../engine/history-view.ts";
import { needsHelp, readHelp, refreshHelp } from "../engine/help-view.ts";
import { adoptHint, loadAdopted, readAdopted } from "../engine/adopt.ts";
import { needsHints, needsTop, readHints, readTopHint, refreshHints, refreshTop } from "../engine/hints-view.ts";
import { needsRemotes, readRemotes, refreshRemotes } from "../engine/sync.ts";
import { currentPrices, lastPriceError } from "../engine/price-update.ts";
import { needsUsage, readUsage, refreshUsage } from "../engine/usage-view.ts";
import { attempt, foldByHand, inBackground, openWindow, readChart, readFoot, readView, setAgent, setCtxAgent, setFull, setListing, setMachines, setMore, setRepoOnly, setSpan, setTranscript, showTab, toggleShown } from "../engine/window.ts";
import { drawInfoRow } from "./desktop-row.tsx";
import { drawFold } from "./fold.tsx";
import { drawFoot } from "./foot.tsx";
import { readLive, watchSession } from "../engine/live.ts";
import { noteMetrics } from "../engine/scroll.ts";
import { glanceLines, glanceOf, moneyOf, pastOf, windowData } from "./data.ts";
import type { WindowData } from "./data.ts";
import { layoutOf, MAX_COLUMNS } from "./layout.ts";
import { ESC_FOLD, hasRepoSwitch, HOW_TO_FOCUS, KEYS_ACTIVE, keyLine, keyLineRuns, spansOf, TABS } from "./keys.ts";
import type { KeyCtx } from "./keys.ts";
import { drawContext } from "./tabs/context.tsx";
import { drawHelp } from "./tabs/help.tsx";
import { drawHistory } from "./tabs/history.tsx";
import { drawHints } from "./tabs/hints.tsx";
import { drawSession } from "./tabs/session.tsx";
import { drawUsage } from "./tabs/usage.tsx";
import { tableOf } from "./table.ts";
import type { Table } from "./table.ts";
import { hintLine, heightOf, windowOf, withAutoFocus } from "./scroll.ts";
import { tabFaces } from "./tabbar.ts";
import { SEP } from "./theme.ts";

/** How many hints the session has, as the Hints tab's face shows it; 0 until the leading hint is built. */
async function hintCount($: EngineInterface): Promise<number> {
  const [live, top] = await Promise.all([readLive($), readTopHint($)]);
  return top.sessionId === live.sessionId ? top.count : 0;
}

/** The rows with `autoFocus` on the first Button among them, so the focus ring starts in the content and not on the tab bar. */
function focusFirst(rows: RenderElement[]): RenderElement[] {
  for (let i = 0; i < rows.length; i++) {
    const hit = withAutoFocus(rows[i] as RenderElement);
    if (hit !== null) return [...rows.slice(0, i), hit, ...rows.slice(i + 1)];
  }
  return rows;
}

/** Everything a drawing reads, built from the atoms and the clock. */
async function loadData($: EngineInterface, settings: Pick<Settings, "money" | "decimals">): Promise<WindowData> {
  const [live, foot, chart, top, now] = await Promise.all([readLive($), readFoot($), readChart($), readTopHint($), $.clock.now()]);
  // The session's leading hint is rebuilt off the draw once it is stale; until then the line shows none.
  if (needsTop(top, live.sessionId, now)) inBackground($, () => refreshTop($, live.sessionId));
  const hint = top.sessionId === live.sessionId && top.hint !== null ? glanceOf(top.hint, settings) : null;
  return windowData({ live, foot, chart, hint, past: pastOf(await readHistory($), now), settings, now });
}

const SPAN_LABEL: Record<Span, string> = { session: "Session", "24h": "24 hours", "30d": "30 days" };

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
          {c.isChosen ? chosenFace(t, c.label) : c.label}
        </Button>
      ))}
    </Box>
  );
}

// The chosen tab or switch is bold and underlined, so it reads without the accent colour.
function chosenFace(t: Table, text: string): RenderElement {
  const { Text } = t;
  return (
    <Text weight="bold" underline>
      {text}
    </Text>
  );
}

const rule = (t: Table, cols: number): RenderElement => {
  const { Text } = t;
  return <Text dimColor>{"\u{2500}".repeat(Math.max(0, cols))}</Text>;
};

function drawShort(t: Table, d: WindowData, cols: number, isFocused: boolean, isFullscreen: boolean): RenderElement {
  const { Box, Text } = t;
  const lines = glanceLines(d, cols);
  // Short only when the frame is under 6 rows: the tabs need more height. The note is short so it is never cut.
  const note = isFullscreen ? "taller for tabs" : "taller or /tui fullscreen for tabs";
  return (
    <Box key="short" flexDirection="column">
      {lines.map((line, i) => (
        <Text key={`short-${i}`} {...(i === 0 ? { weight: "bold" } : {})} wrap="truncate-end">
          {line}
        </Text>
      ))}
      {t.hasKeys && (
        <Text dimColor wrap="truncate-end">
          {`${isFocused ? `${KEYS_ACTIVE}${SEP}${ESC_FOLD}` : HOW_TO_FOCUS}${SEP}${note}`}
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
      {d.models.length > 0 && (
        <Text dimColor wrap="truncate-end">
          {d.models.map(([name, usd]) => `${name} ${moneyOf(d, usd)}`).join(SEP)}
        </Text>
      )}
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
  // Content is never wider than MAX_COLUMNS: a wider body leaves the rest empty, on the right.
  const cols = Math.min(e.props.bodyColumns, MAX_COLUMNS);
  const isCapped = e.props.bodyColumns > MAX_COLUMNS;
  const rows = e.props.scroll.bodyRows;
  const isFullscreen = e.viewport?.isFullscreen === true;
  const placement = e.props.placement === "inline" ? "inline" : "dock";
  // A widget (the desktop's small form of a minimised pane) draws what reads at a glance, like a short inline frame.
  const layout = e.props.placement === "widget" ? "short" : layoutOf(cols, rows, placement);
  if (layout === "short") {
    // The short view carries today's and the month's spend once the Spend figures are held; ask for them off the draw.
    const [held, scan] = await Promise.all([readHistory($), readScanView($)]);
    wantHistory($, held, scan, { repoOnly: false, sync: settings.syncDir !== "" }, d.now);
    return drawShort(t, d, cols, e.props.isFocused, isFullscreen);
  }
  if (layout === "compact") return drawCard(t, d, cols);

  const isNarrow = layout === "narrow";
  const tab = view.tab;
  const span = spanFor(tab, view.span);
  const ctx: KeyCtx = { machines: settings.syncDir !== "" };

  // On the terminal the bar is one row at any width: digits shown, names shortened as the width falls, the Hints face
  // carrying the session's hint count. Elsewhere the buttons wrap as before.
  const bar = t.hasKeys ? tabFaces(cols, await hintCount($)) : null;
  const tabBar = (
    <Box key="tabs" flexDirection="row" columnGap={1} {...(bar === null && { flexWrap: "wrap" as const })}>
      {TABS.map((s) => {
        const text = bar === null ? (isNarrow ? s.short : s.label) : bar.faces[s.tab];
        return (
          <Button
            key={`tab-${s.tab}`}
            label={text}
            hotkey={s.hotkey}
            {...(bar !== null && { plain: true as const })}
            {...(s.tab === tab ? { variant: "primary" as const } : { dimColor: true })}
            onPress={() => attempt($, () => showTab($, s.tab))}
          >
            {s.tab === tab ? chosenFace(t, text) : text}
          </Button>
        );
      })}
      {(bar === null || bar.fold !== "") && (
        <Button key="tally-pane-fold" label="fold" dimColor {...(bar !== null && { plain: true as const })} onPress={() => attempt($, () => foldByHand($))}>
          {bar === null ? "\u{00d7} fold" : bar.fold}
        </Button>
      )}
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
  if (ctx.machines === true && (tab === "history" || tab === "hints")) {
    switches.push(
      switchRow(t, "Computers", "t", [
        { key: "machines-this", label: "This computer", isChosen: view.machines === "this", onPress: () => attempt($, () => setMachines($, "this")) },
        { key: "machines-all", label: "All computers", isChosen: view.machines === "all", onPress: () => attempt($, () => setMachines($, "all")) },
      ]),
    );
  }

  let tabRows: RenderElement[];
  if (tab === "session") {
    const [live, data, prices] = await Promise.all([readLive($), readSession($), currentPrices($)]);
    const drawn = drawSession(t, {
      d,
      live,
      data,
      prices,
      cols,
      more: view.more,
      onMore: (more) => attempt($, () => setMore($, more)),
      // A token row drills to Tokens, on this session.
      onUsage: () =>
        attempt($, async () => {
          await setSpan($, "session");
          await showTab($, "usage");
        }),
      onContext: () => attempt($, () => showTab($, "context")),
      onHints: () => attempt($, () => showTab($, "hints")),
    });
    tabRows = drawn.rows;
    Object.assign(ctx, drawn.ctx);
  } else if (tab === "usage") {
    const [live, data] = await Promise.all([readLive($), readUsage($)]);
    const want = { span, sessionId: live.sessionId };
    // Figures of another span, or old ones, are rebuilt off the draw; the tab shows what it has meanwhile.
    if (needsUsage(data, want, d.now)) inBackground($, () => refreshUsage($, want));
    const drawn = drawUsage(t, {
      d,
      data,
      span,
      sessionId: live.sessionId,
      view: { agent: view.agent, listing: view.listing, full: view.full, shown: view.shown, more: view.more },
      cols,
      redact: settings.redactEvidence,
      onAgent: (key) => attempt($, () => setAgent($, key)),
      onListing: (listing) => attempt($, () => setListing($, listing)),
      onFull: (full) => attempt($, () => setFull($, full)),
      onShown: (key) => attempt($, () => toggleShown($, key)),
      onMore: (more) => attempt($, () => setMore($, more)),
      onCopy: (text) =>
        attempt($, async () => {
          const done = await $.ui.copy({ text, surface: e.surface });
          if (!done.isCopied) $.ui.toast("tally: could not copy to the clipboard.");
        }),
    });
    tabRows = drawn.rows;
    Object.assign(ctx, drawn.ctx);
  } else if (tab === "context") {
    const [live, data, states, transcripts] = await Promise.all([readLive($), readContext($), readAgentStates($), readTranscripts($)]);
    // A stale reading, or an agent's transcript in view that is not read yet, is fetched off the draw.
    wantContext($, data, states, live, d.now);
    const chosen = live.agents[view.ctxAgent];
    if (chosen !== undefined && view.transcript && needsTranscript(transcripts.byAgent[chosen.id], d.now)) {
      inBackground($, () => loadTranscript($, live.sessionId, chosen.id, chosen.type));
    }
    const drawn = drawContext(t, {
      d,
      live,
      data,
      states,
      transcripts: transcripts.byAgent,
      view: { ctxAgent: view.ctxAgent, listing: view.listing, more: view.more, transcript: view.transcript },
      onAgent: (id) => attempt($, () => setCtxAgent($, id)),
      onListing: (listing) => attempt($, () => setListing($, listing)),
      onMore: (more) => attempt($, () => setMore($, more)),
      onTranscript: (on) => attempt($, () => setTranscript($, on)),
    });
    tabRows = drawn.rows;
    Object.assign(ctx, drawn.ctx);
  } else if (tab === "history") {
    const [data, scan, live] = await Promise.all([readHistory($), readScanView($), readLive($)]);
    // Stale figures, or a scan not looked at lately, are handled off the draw; the tab shows what it has meanwhile.
    wantHistory($, data, scan, { repoOnly: view.repoOnly, sync: ctx.machines === true, span, sessionId: live.sessionId }, d.now);
    const drawn = drawHistory(t, {
      d,
      data,
      machines: view.machines,
      sync: ctx.machines === true,
      scan: scan.scan,
      span,
      sessionId: live.sessionId,
      repoOnly: view.repoOnly,
      view: { more: view.more, shown: view.shown },
      onMore: (more) => attempt($, () => setMore($, more)),
      onShown: (key) => attempt($, () => toggleShown($, key)),
    });
    tabRows = drawn.rows;
    Object.assign(ctx, drawn.ctx);
  } else if (tab === "hints") {
    const [live, data, adopted] = await Promise.all([readLive($), readHints($), readAdopted($)]);
    if (!adopted.loaded) inBackground($, () => loadAdopted($));
    const want = { span, repoOnly: view.repoOnly, sessionId: live.sessionId };
    // Stale findings, or those of another span or repo, are rebuilt off the draw; the tab shows what it has meanwhile.
    if (needsHints(data, want, d.now)) inBackground($, () => refreshHints($, want));
    // The other computers' files are read off the draw while the all-computers view is on.
    const remote = await readRemotes($);
    if (ctx.machines === true && view.machines === "all" && needsRemotes(remote, d.now)) inBackground($, () => refreshRemotes($, settings));
    const drawn = drawHints(t, {
      d,
      data,
      want,
      view: { shown: view.shown },
      redact: settings.redactEvidence,
      ...(ctx.machines === true && { machines: { mode: view.machines, remote } }),
      onShown: (key) => attempt($, () => toggleShown($, key)),
      adopted: adopted.list.map((a) => a.rule),
      onAdopt: (hint) => attempt($, () => adoptHint($, hint)),
    });
    tabRows = drawn.rows;
    Object.assign(ctx, drawn.ctx);
  } else {
    const [data, prices, priceError] = await Promise.all([readHelp($), currentPrices($), lastPriceError($)]);
    // The version and the unpriced models are read off the draw; the tab shows what it has meanwhile.
    if (needsHelp(data, d.now)) inBackground($, () => refreshHelp($));
    const drawn = drawHelp(t, { settings, prices, ...(priceError !== undefined && { priceError }), data });
    tabRows = drawn.rows;
    Object.assign(ctx, drawn.ctx);
  }
  // flexShrink 0: when a tab is taller than the dock, rows keep their height and the dock clips the rest. A shrinkable
  // body squeezes its rows under their text, so a wrapped row's second line is drawn over by the row below.
  const body = (
    <Box key={`body-${tab}`} flexDirection="column" flexShrink={0}>
      {tabRows}
    </Box>
  );
  // The key line: key names bold, their words dim, this tab's keys before the global pair.
  const keys = t.hasKeys ? (
    <Text key="keys" dimColor wrap="truncate-end">
      {keyLineRuns(cols, e.props.isFocused, keyLine(tab, ctx)).map((r, i) => (
        <Text key={`key-run-${i}`} {...(r.role === "key" ? { weight: "bold" as const } : { dimColor: true })}>
          {r.text}
        </Text>
      ))}
    </Text>
  ) : null;
  const head = [tabBar, ...switches, ...(switches.length > 0 ? [rule(t, cols)] : [])];
  const footRows = drawFoot(t, d, cols);
  const foots = [...(keys === null ? [] : [keys]), rule(t, cols), ...footRows];
  // Until the first action an inline frame says docking needs fullscreen; only a full drawing has the room for it.
  const showTip = placement === "inline" && layout === "full" && !view.hasTipped && !isFullscreen;
  const tip = showTip ? (
    <Box key="tip">
      <Text dimColor wrap="truncate-end">
        fullscreen docks this window: /tui fullscreen
      </Text>
    </Box>
  ) : null;

  if (t.hasKeys) {
    // Head and foot stay put and the tab's rows scroll between them, a row at a time. The rows are windowed here (the
    // engine clips a tree it has no window over); `ui.scroll` (wheel, PgUp/PgDn) moves the window (engine/scroll.ts).
    // Docked, the tree is the dock's height. Inline it is as tall as it needs, at most the frame's rows.
    let top = [...(tip === null ? [] : [tip]), ...head];
    let bottom = foots;
    const height = (els: RenderElement[]): number => els.reduce((n, el) => n + heightOf(el, cols), 0);
    // A frame too short for any body drops the key line and rule first, then the tip and the rule under the switches,
    // then all but the first foot row.
    if (rows - height(top) - height(bottom) < 4 && placement === "inline") bottom = [...footRows];
    if (rows - height(top) - height(bottom) < 3 && placement === "inline") top = [tabBar, ...switches];
    if (rows - height(top) - height(bottom) < 3 && placement === "inline") bottom = footRows.slice(0, 1);
    const win = windowOf(tabRows, cols, rows - height(top) - height(bottom), view.scroll);
    noteMetrics({ active: win.overflows, heights: win.heights, capacity: win.capacity, maxOffset: win.maxOffset });
    return (
      <Box key="window" flexDirection="column" {...(placement === "dock" && { height: rows })} {...(isCapped && { width: cols })}>
        <Box flexDirection="column" flexShrink={0}>
          {top}
        </Box>
        <Box flexDirection="column" flexShrink={0} {...(placement === "dock" && { flexGrow: 1, flexShrink: 1, overflow: "hidden" as const })}>
          <Box key={`body-${tab}`} flexDirection="column" flexShrink={0}>
            {focusFirst(win.rows)}
          </Box>
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          {win.overflows && (
            <Text key="scroll-hint" dimColor wrap="truncate-end">
              {hintLine(win, cols)}
            </Text>
          )}
          {bottom}
        </Box>
      </Box>
    );
  }
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
  // Off the terminal, an inline frame is as tall as its tree and the surface scrolls it whole.
  return (
    <Box key="window" flexDirection="column">
      {tip}
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
  // A /clear or /resume changes the session id with no start event: seat the view for it on this draw.
  attempt($, () => watchSession($));
  const onOpen = () => attempt($, () => openWindow($, settings, { asked: true }));
  if (e.surface === "desktop" && settings.desktopRow) return drawInfoRow($, e, await loadData($, settings), onOpen);
  if ((await readView($)).mode !== "folded") return next(e);
  return drawFold($, e, await loadData($, settings), onOpen);
}
