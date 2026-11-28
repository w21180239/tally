// The Usage tab: where the tokens of a span went, by billed kind. One block per kind, each row an amount of
// tokens and money; estimated rows carry `~`. Rows with a longer text behind them open to it, and the whole
// tab can be copied as plain text. `drawUsage` returns the rows and the keys they add.
import type { RenderElement } from "claude-code";
import type { Span } from "../../core/summary.ts";
import { KIND_LABEL, KIND_NOTE, usageText } from "../../core/usage-detail.ts";
import type { DetailRow } from "../../core/usage-detail.ts";
import { usageKeyOf } from "../../engine/usage-view.ts";
import type { UsageData, UsageSection } from "../../engine/usage-view.ts";
import { headlineOf, moneyColumn, tokensText } from "../data.ts";
import type { WindowData } from "../data.ts";
import { gridOf } from "../grid.ts";
import type { KeyCtx } from "../keys.ts";
import { blank as gap, row, section, status } from "../rows.tsx";
import type { Table } from "../table.ts";
import { SEP } from "../theme.ts";

/** Items listed under a group before the rest fold under `m`. */
export const ITEM_ROWS = 3;
const FULL_LINES = 12;
/** A row's full text hangs under its label, a step deeper than the row itself. */
const FULL_INDENT = 4;

export type UsageView = { agent: string; listing: boolean; full: boolean; shown: string[]; more: boolean };

export type UsageInput = {
  d: WindowData;
  data: UsageData;
  /** The span asked for, and the live session's id. */
  span: Span;
  sessionId: string;
  view: UsageView;
  cols: number;
  onAgent: (key: string) => void;
  onListing: (listing: boolean) => void;
  onFull: (full: boolean) => void;
  onShown: (key: string) => void;
  onMore: (more: boolean) => void;
  onCopy: (text: string) => void;
};

export type UsageDrawing = { rows: RenderElement[]; ctx: KeyCtx };

const SPAN_WORDS: Record<Span, string> = { session: "this session", "24h": "the past 24 hours", "30d": "the past 30 days" };
const isItem = (r: DetailRow): boolean => r.label.startsWith("  ");

/** The agent keys in step order: all of them, then each agent. */
export const agentOrder = (data: Pick<UsageData, "agents">): string[] => ["", ...data.agents.map((a) => a.key)];

/** The agent `step` places from `current` in the order, wrapping; an unknown `current` counts as all. */
export function stepAgent(order: string[], current: string, step: 1 | -1): string {
  const at = Math.max(0, order.indexOf(current));
  return order[(at + step + order.length) % order.length]!;
}

const agentName = (data: UsageData, key: string): string => (key === "" ? "All agents" : (data.agents.find((a) => a.key === key)?.label ?? key));

type Cut = { rows: Array<{ row: DetailRow; key: string }>; hidden: number };

// A section's rows with each group's items cut to ITEM_ROWS (or all of them when `more`). A row's key names it by
// kind, group and label (a big write by agent and time), so an opened row stays the same row when the lists fold,
// unfold or are rebuilt in another order.
function cutRows(kind: string, rows: DetailRow[], more: boolean): Cut {
  const out: Cut["rows"] = [];
  let run = 0;
  let group = "";
  for (const r of rows) {
    const item = isItem(r);
    run = item ? run + 1 : 0;
    if (!item) group = r.label;
    if (more || run <= ITEM_ROWS) out.push({ row: r, key: r.id !== undefined ? `${kind}|${r.id}` : `${kind}|${item ? group : ""}|${r.label}` });
  }
  return { rows: out, hidden: rows.length - out.length };
}

export function drawUsage(t: Table, i: UsageInput): UsageDrawing {
  const { Box, Text, Button } = t;
  const { d, data, view } = i;
  const ctx: KeyCtx = {};
  const out: RenderElement[] = [];
  const blank = (key: string): RenderElement => gap(t, key);

  if (i.span === "session" && i.sessionId === "") return { rows: [status(t, "none", "No session yet.", "Start a conversation and Usage fills in.")], ctx };
  if (data.key !== usageKeyOf({ span: i.span, sessionId: i.sessionId })) {
    const want = usageKeyOf({ span: i.span, sessionId: i.sessionId });
    if (data.failure?.key === want) return { rows: [status(t, "failed", `Could not read the index: ${data.failure.why}`, "tally reads it again on the next refresh.")], ctx };
    return { rows: [status(t, "loading", "Reading the index...", "Usage fills in as soon as the transcripts are read.")], ctx };
  }
  if (data.requests === 0) {
    const next = i.span === "session" ? "Send a message and this tab fills in. Earlier days are on 4 History." : "Try another time span with s, or look at 4 History.";
    return { rows: [status(t, "empty", `No requests in ${SPAN_WORDS[i.span]}.`, next)], ctx };
  }

  const agent = data.by[view.agent] === undefined ? "" : view.agent;
  const sections: UsageSection[] = data.by[agent] ?? [];
  const spent = sections.reduce((n, s) => n + s.total.usd, 0);
  const tokens = sections.reduce((n, s) => n + s.total.tokens, 0);
  const g = gridOf(t.cols, { tokens: true, money: true, bar: true });
  // One block for every amount in the money column, so the column reads in one unit.
  const money = moneyColumn(d, sections.flatMap((s) => [s.total.usd, ...s.rows.map((r) => r.usd), ...(s.largest ?? []).map((r) => r.usd)]));

  out.push(
    <Box key="headline" flexDirection="row" columnGap={1}>
      <Text weight="bold">{headlineOf(d, spent)}</Text>
      <Text dimColor>{`${tokensText(tokens)} tokens in ${SPAN_WORDS[i.span]}${agent === "" ? "" : `${SEP}${agentName(data, agent)}`}`}</Text>
    </Box>,
  );

  // The agent switch: previous, the one shown, next, and the list that picks one.
  if (data.agents.length > 1) {
    ctx.agents = true;
    const order = agentOrder(data);
    out.push(
      <Box key="agents" flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text dimColor>Agent</Text>
        <Button key="agent-prev" label="prev" hotkey="p" dimColor onPress={() => i.onAgent(stepAgent(order, agent, -1))}>
          prev
        </Button>
        <Text weight="bold">{agentName(data, agent)}</Text>
        <Button key="agent-next" label="next" hotkey="n" dimColor onPress={() => i.onAgent(stepAgent(order, agent, 1))}>
          next
        </Button>
        <Button key="agent-list" label="list" hotkey="a" dimColor onPress={() => i.onListing(!view.listing)}>
          {view.listing ? "close list" : "list"}
        </Button>
      </Box>,
    );
    if (view.listing) {
      out.push(
        <Box key="agent-choices" flexDirection="row" columnGap={1} flexWrap="wrap">
          {order.map((k) => (
            <Button key={`agent-${k === "" ? "all" : k}`} label={agentName(data, k)} {...(k === agent ? { variant: "primary" as const } : { dimColor: true })} onPress={() => i.onAgent(k)}>
              {agentName(data, k)}
            </Button>
          ))}
        </Box>,
      );
    }
  }
  out.push(blank("head"));

  let hidden = 0;
  let canFull = false;
  let hasRows = false;
  const amountRow = (key: string, r: DetailRow, share: number | null): RenderElement[] => {
    const item = isItem(r);
    const opens = r.full !== undefined;
    const rows: RenderElement[] = [
      row(t, g, {
        key,
        label: r.label,
        tokens: tokensText(r.tokens),
        money: money(r.usd),
        ...(r.estimated === true && { est: true }),
        ...(share !== null && { share }),
        ...(item && { quiet: true }),
        ...(opens && { onPress: () => i.onShown(key) }),
      }),
    ];
    if (opens) {
      canFull = true;
      hasRows = true;
      if (view.full || view.shown.includes(key)) {
        const lines = r.full!.split(/\r?\n/);
        const body = lines.length > FULL_LINES ? [...lines.slice(0, FULL_LINES), "..."] : lines;
        // The text wraps under the row's own indent, so a long command reads as one block.
        rows.push(
          <Box key={`${key}-full`} flexDirection="column" paddingLeft={FULL_INDENT}>
            {body.map((line, n) => (
              <Text key={`${key}-line-${n}`} dimColor>
                {line === "" ? " " : line}
              </Text>
            ))}
          </Box>,
        );
      }
    }
    return rows;
  };

  for (const s of sections) {
    out.push(section(t, g, { key: s.kind, name: KIND_LABEL[s.kind], note: KIND_NOTE[s.kind], tokens: tokensText(s.total.tokens), money: money(s.total.usd), est: s.total.estimated === true }));
    const cut = cutRows(s.kind, s.rows, view.more);
    hidden += cut.hidden;
    const top = cut.rows.reduce((n, { row: r }) => (isItem(r) ? n : Math.max(n, r.usd)), 0);
    if (cut.rows.length === 0 && (s.largest ?? []).length === 0) out.push(<Text key={`none-${s.kind}`} dimColor>Nothing in this span.</Text>);
    for (const { row: r, key } of cut.rows) out.push(...amountRow(key, r, isItem(r) || top <= 0 ? null : r.usd / top));
    const largest = s.largest ?? [];
    if (largest.length > 0) {
      out.push(
        <Text key={`largest-${s.kind}`} dimColor>
          Largest single writes
        </Text>,
      );
      const shown = view.more ? largest : largest.slice(0, ITEM_ROWS);
      hidden += largest.length - shown.length;
      const topWrite = shown.reduce((n, r) => Math.max(n, r.usd), 0);
      for (const r of shown) out.push(...amountRow(`${s.kind}|${r.id ?? r.label}`, { ...r, label: `  ${r.label}` }, topWrite > 0 ? r.usd / topWrite : null));
    }
    out.push(blank(s.kind));
  }

  if (hidden > 0 || view.more) {
    ctx.more = true;
    out.push(
      <Button key="lists-more" plain dimColor hotkey="m" onPress={() => i.onMore(!view.more)}>
        {view.more ? "fold lists" : `${hidden} more ${hidden === 1 ? "row" : "rows"}`}
      </Button>,
    );
  }
  if (canFull) {
    ctx.canFull = true;
    out.push(
      <Button key="usage-full" plain dimColor hotkey="v" onPress={() => i.onFull(!view.full)}>
        {view.full ? "hide full text" : "show full text"}
      </Button>,
    );
  }
  if (hasRows) ctx.rows = true;

  const text = usageText(
    `Usage${SEP}${SPAN_WORDS[i.span]}${SEP}${agentName(data, agent)}`,
    sections.map((s) => ({ title: KIND_LABEL[s.kind], total: s.total, rows: [...s.rows, ...(s.largest ?? []).map((r) => ({ ...r, label: `  ${r.label}` }))] })),
    { tokens: tokensText, money },
  );
  out.push(
    <Button key="usage-copy" plain dimColor onPress={() => i.onCopy(text)}>
      copy as text
    </Button>,
  );
  out.push(
    <Text key="usage-note" dimColor wrap="truncate-end">
      {data.snapshot?.proxy === true ? "~ estimated from text length; startup split from another session's snapshot" : "~ estimated from text length, then fitted to what each request reported"}
    </Text>,
  );
  return { rows: out, ctx };
}
