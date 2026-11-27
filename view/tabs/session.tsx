// The Session tab: what this session cost and where it went. Drawn from the live tally, the Foot's refill price
// and the index-backed figures (MCP servers, skills); `drawSession` returns the rows and the keys they add.
import type { RenderElement } from "claude-code";
import type { LiveState } from "../../core/live-state.ts";
import { liveMcp } from "../../core/breakdown.ts";
import type { PriceTable } from "../../core/pricing.ts";
import { agentCaches, kindRows, modelSplit, perActiveHour, whereItWent } from "../../core/where.ts";
import type { KindRow, WentRow } from "../../core/where.ts";
import type { SessionData } from "../../engine/session-view.ts";
import { CACHE_MARK, HINT_MARK, SEP, partCells, partColor, svgBar, svgStack, textBar } from "../theme.ts";
import { leftText, moneyOf, tokensText } from "../data.ts";
import type { WindowData } from "../data.ts";
import type { KeyCtx } from "../keys.ts";
import type { Table } from "../table.ts";

/** Where it went shows this many sub-agent rows before the rest fold under `m`. */
export const AGENT_ROWS = 6;
/** Servers and skills listed before the cut. */
export const LIST_ROWS = 6;
const AMOUNT_CELLS = 9;
const BAR_CELLS = 8;
const SVG_BAR_PX = 60;
const SVG_BAR_H = 8;

export type SessionInput = {
  d: WindowData;
  live: LiveState;
  data: SessionData;
  /** The price table in effect, which prices the refill and schema figures that are not in the index. */
  prices: PriceTable;
  cols: number;
  /** The cut lists are shown whole. */
  more: boolean;
  onMore: (more: boolean) => void;
  /** A token row was pressed: the Usage tab, on this session. */
  onUsage: () => void;
};

export type SessionDrawing = { rows: RenderElement[]; ctx: KeyCtx };

const shortModel = (model: string): string => model.replace(/^claude-/, "");

const KIND_LABEL: Record<KindRow["kind"], string> = {
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  cw1h: "  held 1 hour",
  cw5m: "  held 5 minutes",
};

// One titled block: the title, then its rows, then a blank row.
function title(t: Table, key: string, name: string, note?: string): RenderElement {
  const { Box, Text } = t;
  return (
    <Box key={`title-${key}`} flexDirection="row" columnGap={1}>
      <Text weight="bold">{name}</Text>
      {note !== undefined && <Text dimColor>{note}</Text>}
    </Box>
  );
}

const blank = (t: Table, key: string): RenderElement => {
  const { Text } = t;
  return <Text key={`gap-${key}`}> </Text>;
};

type Line = { key: string; label: string; amount: string; share?: number; quiet?: boolean };

// A label that gives way when the row is narrow, the amount at the right, and an optional share bar.
function amountRow(t: Table, l: Line): RenderElement {
  const { Box, Text, Svg } = t;
  const bar =
    l.share === undefined ? null : Svg === null ? (
      <Text dimColor>{textBar(l.share, BAR_CELLS)}</Text>
    ) : (
      <Svg source={svgBar(l.share, SVG_BAR_PX, SVG_BAR_H, "accent")} alt={`${Math.round(l.share * 100)}%`} width={SVG_BAR_PX} height={SVG_BAR_H} />
    );
  return (
    <Box key={l.key} flexDirection="row" columnGap={1}>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end" dimColor={l.quiet === true}>
          {l.label}
        </Text>
      </Box>
      <Box width={AMOUNT_CELLS} flexShrink={0} justifyContent="flex-end">
        <Text dimColor={l.quiet === true}>{l.amount}</Text>
      </Box>
      {bar}
    </Box>
  );
}

// The by-model stacked bar and its legend: one part per model, costliest first.
function modelBar(t: Table, d: WindowData, models: Array<[string, number]>, cols: number): RenderElement[] {
  const { Box, Text, Svg } = t;
  const shares = models.map(([, usd]) => usd);
  const bar =
    Svg === null ? (
      <Box key="model-bar" flexDirection="row">
        {partCells(shares, Math.max(10, cols - 2)).map((n, i) => (
          <Text key={`seg-${i}`} color={partColor(i)}>
            {"\u{2588}".repeat(n)}
          </Text>
        ))}
      </Box>
    ) : (
      <Svg key="model-bar" source={svgStack(shares, 240, 10)} alt="spend by model" width={240} height={10} />
    );
  return [
    bar,
    <Box key="model-legend" flexDirection="row" columnGap={2} flexWrap="wrap">
      {models.map(([model, usd], i) => (
        <Text key={`legend-${model}`}>
          <Text color={partColor(i)}>{"\u{25a0}"}</Text>
          {` ${shortModel(model)} ${moneyOf(d, usd)}`}
        </Text>
      ))}
    </Box>,
  ];
}

function tokenRows(t: Table, d: WindowData, kinds: KindRow[], onUsage: () => void): RenderElement[] {
  const { Button, Text } = t;
  return kinds
    .filter((k) => k.tokens > 0)
    .map((k) => (
      <Button key={`kind-${k.kind}`} plain dimColor={k.kind === "cw1h" || k.kind === "cw5m"} onPress={onUsage}>
        {KIND_LABEL[k.kind].padEnd(18)}
        <Text dimColor>{`${tokensText(k.tokens).padStart(7)}  ${moneyOf(d, k.usd).padStart(7)}`}</Text>
      </Button>
    ));
}

function cacheRows(t: Table, i: SessionInput): RenderElement[] {
  const { d, live } = i;
  const rows: RenderElement[] = [];
  if (d.cache !== null) {
    const c = d.cache;
    rows.push(
      amountRow(t, {
        key: "cache-main",
        label: `main \u{b7} ${c.isExpired ? "cold, the next request rewrites it" : `${CACHE_MARK} ${leftText(c.leftMs)} left`}`,
        amount: c.refillUsd === null ? "" : moneyOf(d, c.refillUsd),
        ...(c.isExpired ? {} : { quiet: true }),
      }),
    );
  }
  for (const a of agentCaches(live, d.now, i.prices)) {
    rows.push(amountRow(t, { key: `cache-${a.id}`, label: `${a.label} \u{b7} ${CACHE_MARK} ${leftText(a.leftMs)} left`, amount: a.refillUsd === null ? "" : moneyOf(d, a.refillUsd), quiet: true }));
  }
  return rows;
}

/** The Where it went rows with the cut applied: every main, side and earlier row, the first AGENT_ROWS sub-agents. */
export function visibleRows(rows: WentRow[], more: boolean): { shown: WentRow[]; hidden: number } {
  if (more) return { shown: rows, hidden: 0 };
  let agents = 0;
  const shown: WentRow[] = [];
  for (const r of rows) {
    if (r.kind === "agent" && ++agents > AGENT_ROWS) continue;
    shown.push(r);
  }
  return { shown, hidden: rows.length - shown.length };
}

export function drawSession(t: Table, i: SessionInput): SessionDrawing {
  const { Box, Text, Button } = t;
  const { d, live, data } = i;
  const ctx: KeyCtx = {};
  const out: RenderElement[] = [];
  const total = d.costUsd;
  const kinds = kindRows(live, i.prices);
  const tokens = kinds.filter((k) => k.kind === "input" || k.kind === "output" || k.kind === "cacheRead" || k.kind === "cacheWrite").reduce((a, k) => a + k.tokens, 0);

  out.push(
    <Box key="headline" flexDirection="row" columnGap={1}>
      <Text weight="bold">{moneyOf(d, total)}</Text>
      <Text dimColor>{tokens > 0 ? `${tokensText(tokens)} tokens` : "no requests yet"}</Text>
    </Box>,
  );
  const hourly = perActiveHour(live);
  if (hourly !== null) out.push(<Text key="hourly">{`${moneyOf(d, hourly)} an hour while working`}</Text>);
  if (live.restoredUsd > 0) out.push(<Text key="restored" dimColor>{`${moneyOf(d, live.restoredUsd)} of it came before this launch`}</Text>);

  const models = modelSplit(live);
  if (models.length > 0) out.push(...modelBar(t, d, models, i.cols));
  out.push(blank(t, "head"));

  if (tokens > 0) {
    out.push(title(t, "tokens", "Tokens by kind", "press a row for Usage"), ...tokenRows(t, d, kinds, i.onUsage));
    if (live.other.usd > 0) out.push(<Text key="kinds-side" dimColor>{`${moneyOf(d, live.other.usd)} of other API calls is not in these rows`}</Text>);
    out.push(blank(t, "tokens"));
    ctx.rows = true;
  }

  const caches = cacheRows(t, i);
  if (caches.length > 0) out.push(title(t, "cache", "Prompt cache", "time left and the price of a rewrite"), ...caches, blank(t, "cache"));

  const went = whereItWent(live);
  out.push(title(t, "went", "Where it went"));
  if (went.length === 0) out.push(<Text key="went-none" dimColor>Nothing spent yet.</Text>);
  const top = went.reduce((a, r) => Math.max(a, r.usd), 0);
  const { shown, hidden } = visibleRows(went, i.more);
  for (const [n, r] of shown.entries()) {
    out.push(amountRow(t, { key: `went-${n}`, label: r.model === "" ? r.label : `${r.label}${SEP}${shortModel(r.model)}`, amount: moneyOf(d, r.usd), share: top > 0 ? r.usd / top : 0 }));
  }
  if (hidden > 0) out.push(<Text key="went-hidden" dimColor>{`${hidden} more sub-agents`}</Text>);
  out.push(blank(t, "went"));

  // Index-backed lists belong to the live session only.
  const mine = data.sessionId === live.sessionId && live.sessionId !== "";
  // Until the index holds a request of the session, the servers come from the live tally and carry `~`.
  const isGuess = mine && data.rows === 0;
  const servers = !mine ? [] : isGuess ? liveMcp(live, data.resident, i.prices) : data.mcp;
  if (servers.length > 0) {
    const star = data.snapshot?.proxy === true ? "*" : "";
    const guess = isGuess ? "~" : "";
    out.push(title(t, "mcp", "MCP servers", "schemas and results, re-read"));
    for (const m of servers.slice(0, i.more ? undefined : LIST_ROWS)) {
      out.push(amountRow(t, { key: `mcp-${m.server}`, label: `${m.server}${m.calls > 0 ? `${SEP}${m.calls} ${m.calls === 1 ? "call" : "calls"}` : ""}`, amount: `${guess}${moneyOf(d, m.usd)}${star}` }));
    }
    if (star !== "") out.push(<Text key="mcp-note" dimColor>{`* schema sizes from a snapshot taken in another session`}</Text>);
    out.push(<Text key="mcp-scope" dimColor>{isGuess ? "~ schemas only, from this launch's requests; results are priced once the index has the session" : "schemas: main requests; results: main and sub-agents"}</Text>);
    out.push(blank(t, "mcp"));
  }
  if (mine && data.skills.length > 0) {
    out.push(title(t, "skills", "Skills", "requests after a skill call"));
    for (const s of data.skills.slice(0, i.more ? undefined : LIST_ROWS)) out.push(amountRow(t, { key: `skill-${s.name}`, label: s.name, amount: moneyOf(d, s.usd) }));
    out.push(blank(t, "skills"));
  }
  // One key opens every cut list: sub-agents, MCP servers and skills.
  const isCut = went.filter((r) => r.kind === "agent").length > AGENT_ROWS || (mine && (servers.length > LIST_ROWS || data.skills.length > LIST_ROWS));
  if (isCut) {
    ctx.more = true;
    out.push(
      <Button key="lists-more" plain dimColor hotkey="m" onPress={() => i.onMore(!i.more)}>
        {i.more ? "fold lists" : "full lists"}
      </Button>,
    );
  }

  out.push(title(t, "hint", "Leading hint"));
  out.push(
    d.hint === null ? (
      <Text key="hint-none" dimColor>
        No hint for this session yet.
      </Text>
    ) : (
      <Text key="hint" wrap="truncate-end">{`${HINT_MARK} ${d.hint.found}${d.hint.saving === null ? "" : `${SEP}${d.hint.saving}`}`}</Text>
    ),
  );
  return { rows: out, ctx };
}
