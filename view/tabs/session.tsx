// The Session tab: what this session cost and where it went. Drawn from the live tally, the Foot's refill price
// and the index-backed figures (MCP servers, skills); `drawSession` returns the rows and the keys they add.
import type { RenderElement } from "claude-code";
import type { LiveState } from "../../core/live-state.ts";
import { liveMcp } from "../../core/breakdown.ts";
import type { PriceTable } from "../../core/pricing.ts";
import { agentCaches, kindRows, modelSplit, perActiveHour, whereItWent } from "../../core/where.ts";
import type { KindRow, WentRow } from "../../core/where.ts";
import type { SessionData } from "../../engine/session-view.ts";
import { CACHE_MARK, CRIT_MARK, HINT_MARK, SEP, partCells, partColor, partGlyph, svgStack } from "../theme.ts";
import { blockOf, headlineOf, leftText, moneyColumn, tokensText } from "../data.ts";
import type { WindowData } from "../data.ts";
import { gridOf } from "../grid.ts";
import type { KeyCtx } from "../keys.ts";
import { blank, row, section, status } from "../rows.tsx";
import type { Table } from "../table.ts";

/** Where it went shows this many sub-agent rows before the rest fold under `m`. */
export const AGENT_ROWS = 6;
/** Servers and skills listed before the cut. */
export const LIST_ROWS = 6;

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
  /** An agent row was pressed: the Context tab. Without it those rows are plain. */
  onContext?: () => void;
  /** The leading hint was pressed: the Hints tab. Without it the row is plain. */
  onHints?: () => void;
};

export type SessionDrawing = { rows: RenderElement[]; ctx: KeyCtx };

const shortModel = (model: string): string => model.replace(/^claude-/, "");

const KIND_LABEL: Record<KindRow["kind"], string> = {
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  cw1h: "held 1 hour",
  cw5m: "held 5 minutes",
};

// The by-model stacked bar and its legend: one part per model, costliest first, each its own shape and colour.
function modelBar(t: Table, d: WindowData, models: Array<[string, number]>, cols: number): RenderElement[] {
  const { Box, Text, Svg } = t;
  const shares = models.map(([, usd]) => usd);
  const shown = blockOf(d, shares);
  const bar =
    Svg === null ? (
      <Box key="model-bar" flexDirection="row">
        {partCells(shares, Math.max(10, cols - 2)).map((n, i) => (
          <Text key={`seg-${i}`} color={partColor(i)}>
            {partGlyph(i).repeat(n)}
          </Text>
        ))}
      </Box>
    ) : (
      <Svg key="model-bar" source={svgStack(shares, 240, 10)} alt="spend by model" width={240} height={10} />
    );
  return [
    bar,
    <Box key="model-legend" flexDirection="row" columnGap={2} flexWrap="wrap">
      {models.map(([model], i) => (
        <Text key={`legend-${model}`}>
          <Text color={partColor(i)}>{Svg === null ? partGlyph(i) : "\u{25a0}"}</Text>
          {` ${shortModel(model)} ${shown[i]}`}
        </Text>
      ))}
    </Box>,
  ];
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
  const g = gridOf(t.cols, { tokens: true, money: true, bar: true });
  const total = d.costUsd;
  const kinds = kindRows(live, i.prices).filter((k) => k.tokens > 0);
  const main = kinds.filter((k) => k.kind === "input" || k.kind === "output" || k.kind === "cacheRead" || k.kind === "cacheWrite");
  const tokens = main.reduce((a, k) => a + k.tokens, 0);
  const went = whereItWent(live);
  const caches = [...(d.cache === null ? [] : [{ id: "main", usd: d.cache.refillUsd }]), ...agentCaches(live, d.now, i.prices).map((a) => ({ id: a.id, usd: a.refillUsd }))];
  const mine = data.sessionId === live.sessionId && live.sessionId !== "";
  // Until the index holds a request of the session, the servers come from the live tally and carry `~`.
  const isGuess = mine && data.rows === 0;
  const servers = !mine ? [] : isGuess ? liveMcp(live, data.resident, i.prices) : data.mcp;
  const skills = mine ? data.skills : [];
  // One block for every amount in the tab's money column.
  const money = moneyColumn(d, [
    ...kinds.map((k) => k.usd),
    main.reduce((a, k) => a + k.usd, 0),
    ...caches.flatMap((c) => (c.usd === null ? [] : [c.usd])),
    ...went.map((r) => r.usd),
    ...servers.map((m) => m.usd),
    ...skills.map((s) => s.usd),
  ]);

  out.push(
    <Box key="headline" flexDirection="row" columnGap={1}>
      <Text weight="bold">{headlineOf(d, total)}</Text>
      <Text dimColor>{tokens > 0 ? `${tokensText(tokens)} tokens` : "no requests yet"}</Text>
    </Box>,
  );
  // A session with nothing in it has one state, not a column of empty sections.
  if (tokens === 0 && total === 0 && went.length === 0) {
    out.push(status(t, "empty", "Nothing has been spent in this session.", "Send a message and this tab fills in. Earlier days are on 4 History."));
    return { rows: out, ctx };
  }
  // A rate over a few seconds of turn time is not a rate.
  const hourly = perActiveHour(live);
  if (hourly !== null && live.activeMs >= 60_000) out.push(<Text key="hourly">{`${headlineOf(d, hourly)} an hour while working`}</Text>);
  if (live.restoredUsd > 0) out.push(<Text key="restored" dimColor>{`${headlineOf(d, live.restoredUsd)} of it came before this launch`}</Text>);

  const models = modelSplit(live);
  if (models.length > 0) out.push(...modelBar(t, d, models, i.cols));
  out.push(blank(t, "head"));

  if (tokens > 0) {
    const top = main.reduce((a, k) => Math.max(a, k.usd), 0);
    out.push(section(t, g, { key: "tokens", name: "Billed kinds", note: "press a row for Usage", tokens: tokensText(tokens), money: money(main.reduce((a, k) => a + k.usd, 0)) }));
    for (const k of kinds) {
      const isSub = k.kind === "cw1h" || k.kind === "cw5m";
      out.push(row(t, g, { key: `kind-${k.kind}`, label: KIND_LABEL[k.kind], indent: isSub, tokens: tokensText(k.tokens), money: money(k.usd), ...(isSub ? { quiet: true } : { share: top > 0 ? k.usd / top : 0 }), onPress: i.onUsage }));
    }
    if (live.other.usd > 0) out.push(<Text key="kinds-side" dimColor wrap="truncate-end">{`${headlineOf(d, live.other.usd)} of other API calls is not in these rows`}</Text>);
    out.push(blank(t, "tokens"));
    ctx.rows = true;
  }

  if (caches.length > 0) {
    out.push(section(t, g, { key: "cache", name: "Prompt cache", note: "time left and rewrite cost" }));
    if (d.cache !== null) {
      const c = d.cache;
      out.push(
        row(t, g, {
          key: "cache-main",
          label: c.isExpired ? `${CRIT_MARK} main${SEP}expired${SEP}next request rewrites` : `main${SEP}${CACHE_MARK} ${leftText(c.leftMs)} left`,
          ...(c.refillUsd === null ? {} : { money: money(c.refillUsd) }),
          ...(c.isExpired ? {} : { quiet: true }),
        }),
      );
    }
    for (const a of agentCaches(live, d.now, i.prices)) {
      out.push(row(t, g, { key: `cache-${a.id}`, label: `${a.label}${SEP}${CACHE_MARK} ${leftText(a.leftMs)} left`, ...(a.refillUsd === null ? {} : { money: money(a.refillUsd) }), quiet: true }));
    }
    out.push(blank(t, "cache"));
  }

  out.push(section(t, g, { key: "went", name: "Where it went" }));
  if (went.length === 0) out.push(<Text key="went-none" dimColor>Nothing spent yet.</Text>);
  const top = went.reduce((a, r) => Math.max(a, r.usd), 0);
  const { shown, hidden } = visibleRows(went, i.more);
  for (const [n, r] of shown.entries()) {
    const label = r.model === "" ? r.label : `${r.label}${SEP}${shortModel(r.model)}`;
    out.push(row(t, g, { key: `went-${n}`, label, money: money(r.usd), share: top > 0 ? r.usd / top : 0, ...(r.kind === "agent" && i.onContext !== undefined && { onPress: i.onContext }) }));
  }
  if (hidden > 0) out.push(<Text key="went-hidden" dimColor>{`${hidden} more sub-agents`}</Text>);
  out.push(blank(t, "went"));

  if (servers.length > 0) {
    const star = data.snapshot?.proxy === true ? "*" : "";
    out.push(section(t, g, { key: "mcp", name: "MCP servers", note: "schemas and results, re-read" }));
    for (const m of servers.slice(0, i.more ? undefined : LIST_ROWS)) {
      out.push(row(t, g, { key: `mcp-${m.server}`, label: `${m.server}${m.calls > 0 ? `${SEP}${m.calls} ${m.calls === 1 ? "call" : "calls"}` : ""}`, money: `${money(m.usd)}${star}`, est: isGuess }));
    }
    if (star !== "") out.push(<Text key="mcp-note" dimColor wrap="truncate-end">{`* schema sizes from a snapshot taken in another session`}</Text>);
    out.push(<Text key="mcp-scope" dimColor wrap="truncate-end">{isGuess ? "~ schemas only, from this launch's requests; results are priced once the index has the session" : "schemas: main requests; results: main and sub-agents"}</Text>);
    out.push(blank(t, "mcp"));
  }
  if (skills.length > 0) {
    out.push(section(t, g, { key: "skills", name: "Skills", note: "requests after a skill call" }));
    for (const s of skills.slice(0, i.more ? undefined : LIST_ROWS)) out.push(row(t, g, { key: `skill-${s.name}`, label: s.name, money: money(s.usd) }));
    out.push(blank(t, "skills"));
  }
  // One key opens every cut list: sub-agents, MCP servers and skills.
  const isCut = went.filter((r) => r.kind === "agent").length > AGENT_ROWS || servers.length > LIST_ROWS || skills.length > LIST_ROWS;
  if (isCut) {
    ctx.more = true;
    out.push(
      <Button key="lists-more" plain dimColor hotkey="m" onPress={() => i.onMore(!i.more)}>
        {i.more ? "fold lists" : "full lists"}
      </Button>,
    );
  }

  out.push(section(t, g, { key: "hint", name: "Leading hint" }));
  if (d.hint === null) {
    out.push(<Text key="hint-none" dimColor>No hint for this session yet.</Text>);
  } else {
    const label = `${HINT_MARK} ${d.hint.found}${d.hint.saving === null ? "" : `${SEP}save ${d.hint.saving}`}`;
    out.push(row(t, g, { key: "hint", label, ...(i.onHints !== undefined && { onPress: i.onHints }) }));
  }
  return { rows: out, ctx };
}
