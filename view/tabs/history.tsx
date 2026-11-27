// The History tab: a month of spend, for all repos or the live session's repo alone. Rows by billed kind, day, model,
// main thread against sub-agents, sub-agent type, repo and session, then what each tool added to context and what each
// MCP server cost. A running transcript scan is named with its percent. `drawHistory` returns the rows and the keys
// they add.
import type { RenderElement } from "claude-code";
import { dayWords, historyKeyOf, localDayName, scanText } from "../../core/history.ts";
import type { HistoryData, ScanState } from "../../core/history.ts";
import { KIND_LABEL, shortModel } from "../../core/usage-detail.ts";
import { moneyOf, tokensText } from "../data.ts";
import type { WindowData } from "../data.ts";
import type { KeyCtx } from "../keys.ts";
import { amountRow, blank, textLines, title } from "../rows.tsx";
import type { Table } from "../table.ts";
import { SEP } from "../theme.ts";

/** Rows a section lists before `m` opens the rest; the day list shows a week. */
export const SECTION_ROWS = 5;
export const DAYS_SHOWN = 7;
const DETAIL_LINES = 6;

export type HistoryView = { more: boolean; shown: string[] };

export type HistoryInput = {
  d: WindowData;
  data: HistoryData;
  /** The scan under way, or null. */
  scan: ScanState | null;
  repoOnly: boolean;
  view: HistoryView;
  onMore: (more: boolean) => void;
  onShown: (key: string) => void;
};

export type HistoryDrawing = { rows: RenderElement[]; ctx: KeyCtx };

/** A session row's key is its id, so an open row stays open however the lists are cut or rebuilt. */
export const sessionRowKey = (sessionId: string): string => `session|${sessionId}`;

const SPAN_WORDS = "the past 30 days";

export function drawHistory(t: Table, i: HistoryInput): HistoryDrawing {
  const { Text, Button } = t;
  const { d, data, view } = i;
  const ctx: KeyCtx = {};
  const out: RenderElement[] = [];
  const want = historyKeyOf(i.repoOnly);
  const scanLine: RenderElement[] =
    i.scan === null
      ? []
      : [
          <Text key="scan" dimColor wrap="truncate-end">
            {scanText(i.scan)}
          </Text>,
        ];

  if (data.key !== want) {
    if (data.failure?.key === want) return { rows: [<Text key="failed" dimColor wrap="truncate-end">{`Could not read the index: ${data.failure.why}`}</Text>], ctx };
    return { rows: [<Text key="loading" dimColor>Reading the index...</Text>, ...scanLine], ctx };
  }
  const where = i.repoOnly ? ` in ${data.repo}` : "";
  if (data.requests === 0) {
    // No index yet means unknown, not zero.
    if (i.scan !== null || data.unread > 0) {
      return { rows: [<Text key="unknown" dimColor>{`No figures for ${SPAN_WORDS}${where} yet: the transcripts are not indexed.`}</Text>, ...scanLine], ctx };
    }
    return { rows: [<Text key="empty" dimColor>{`No requests in ${SPAN_WORDS}${where}.`}</Text>], ctx };
  }

  const { Box } = t;
  out.push(
    <Box key="headline" flexDirection="row" columnGap={1}>
      <Text weight="bold">{moneyOf(d, data.total.usd)}</Text>
      <Text dimColor wrap="truncate-end">{`${tokensText(data.total.tokens)} tokens in ${SPAN_WORDS}${SEP}${data.requests} ${data.requests === 1 ? "request" : "requests"}${i.repoOnly ? `${SEP}${data.repo}` : ""}`}</Text>
    </Box>,
    ...scanLine,
  );
  if (i.scan === null && data.unread > 0) {
    out.push(
      <Text key="unread" dimColor wrap="truncate-end">
        {`${data.unread} ${data.unread === 1 ? "project is" : "projects are"} not indexed yet; their spend is not counted.`}
      </Text>,
    );
  }
  if (data.unpriced.length > 0) {
    out.push(
      <Text key="unpriced" dimColor wrap="truncate-end">
        {`No price for ${data.unpriced.join(", ")}; counted as $0.`}
      </Text>,
    );
  }
  out.push(blank(t, "head"));

  let hidden = 0;
  // The first `n` of `rows` (all with the lists open); the rest add to the count on the `m` button.
  const shownOf = <T,>(rows: T[], n: number): T[] => {
    const kept = view.more ? rows : rows.slice(0, n);
    hidden += rows.length - kept.length;
    return kept;
  };
  const topOf = (values: number[]): number => values.reduce((a, v) => Math.max(a, v), 0);
  const share = (v: number, top: number): number => (top > 0 ? v / top : 0);

  out.push(title(t, "kinds", "Billed kinds", "tokens and spend"));
  const kindTop = topOf(data.kinds.map((k) => k.usd));
  for (const k of data.kinds) out.push(amountRow(t, { key: `kind-${k.kind}`, label: `${KIND_LABEL[k.kind]}${SEP}${tokensText(k.tokens)}`, amount: moneyOf(d, k.usd), share: share(k.usd, kindTop) }));
  out.push(blank(t, "kinds"));

  out.push(title(t, "days", "Spend per day", "newest first"));
  const dayTop = topOf(data.days.map((x) => x.usd));
  for (const x of shownOf(data.days, DAYS_SHOWN)) out.push(amountRow(t, { key: `day-${x.day}`, label: `${dayWords(x.day)}${SEP}${tokensText(x.tokens)}`, amount: moneyOf(d, x.usd), share: share(x.usd, dayTop) }));
  out.push(blank(t, "days"));

  out.push(title(t, "models", "Spend per model"));
  const modelTop = topOf(data.models.map((m) => m.usd));
  for (const m of shownOf(data.models, SECTION_ROWS)) out.push(amountRow(t, { key: `model-${m.name}`, label: shortModel(m.name), amount: moneyOf(d, m.usd), share: share(m.usd, modelTop) }));
  out.push(blank(t, "models"));

  out.push(title(t, "split", "Main thread and sub-agents"));
  const splitTop = Math.max(data.main.usd, data.sub.usd);
  out.push(amountRow(t, { key: "split-main", label: "Main thread", amount: moneyOf(d, data.main.usd), share: share(data.main.usd, splitTop) }));
  out.push(amountRow(t, { key: "split-sub", label: "Sub-agents", amount: moneyOf(d, data.sub.usd), share: share(data.sub.usd, splitTop) }));
  out.push(blank(t, "split"));

  if (data.subTypes.length > 0) {
    out.push(title(t, "subtypes", "Sub-agent type and model"));
    const top = topOf(data.subTypes.map((s) => s.usd));
    for (const s of shownOf(data.subTypes, SECTION_ROWS)) out.push(amountRow(t, { key: `subtype-${s.type}-${s.model}`, label: `${s.type}${SEP}${shortModel(s.model)}`, amount: moneyOf(d, s.usd), share: share(s.usd, top) }));
    out.push(blank(t, "subtypes"));
  }

  if (!i.repoOnly && data.repos.length > 0) {
    out.push(title(t, "repos", "Spend per repo"));
    const top = topOf(data.repos.map((r) => r.usd));
    for (const r of shownOf(data.repos, SECTION_ROWS)) out.push(amountRow(t, { key: `repo-${r.name}`, label: r.name, amount: moneyOf(d, r.usd), share: share(r.usd, top) }));
    out.push(blank(t, "repos"));
  }

  if (data.sessions.length > 0) {
    out.push(title(t, "sessions", "Largest sessions", "press a row for its resume command"));
    const top = topOf(data.sessions.map((s) => s.usd));
    for (const s of shownOf(data.sessions, SECTION_ROWS)) {
      const key = sessionRowKey(s.sessionId);
      const name = s.title === undefined || s.title === "" ? s.sessionId.slice(0, 8) : s.title;
      const day = dayWords(localDayName(s.started, -new Date(s.started).getTimezoneOffset()));
      out.push(amountRow(t, { key, label: `${name}${SEP}${day}${SEP}${s.repo}`, amount: moneyOf(d, s.usd), share: share(s.usd, top), onPress: () => i.onShown(key) }));
      ctx.rows = true;
      if (view.shown.includes(key)) {
        const lines = [...(s.title === undefined || s.title === "" ? [] : [s.title]), `session ${s.sessionId}`, ...(s.pr === undefined ? [] : [`PR ${s.pr}`]), s.resume];
        out.push(textLines(t, `${key}-detail`, lines.join("\n"), DETAIL_LINES));
      }
    }
    out.push(blank(t, "sessions"));
  }

  if (data.fill.length > 0) {
    out.push(title(t, "fill", "Context fill by tool", "tokens each tool added, estimated"));
    const top = topOf(data.fill.map((f) => f.tokens));
    for (const f of shownOf(data.fill, SECTION_ROWS)) out.push(amountRow(t, { key: `fill-${f.tool}`, label: f.tool, amount: `~${tokensText(f.tokens)}`, share: share(f.tokens, top) }));
    out.push(blank(t, "fill"));
  }

  if (data.mcp.length > 0) {
    const star = data.mcpProxy ? "*" : "";
    out.push(title(t, "mcp", "MCP servers", "schemas and results, re-read"));
    const top = topOf(data.mcp.map((m) => m.usd));
    for (const m of shownOf(data.mcp, SECTION_ROWS)) {
      out.push(amountRow(t, { key: `mcp-${m.server}`, label: `${m.server}${m.calls > 0 ? `${SEP}${m.calls} ${m.calls === 1 ? "call" : "calls"}` : ""}`, amount: `${moneyOf(d, m.usd)}${star}`, share: share(m.usd, top) }));
    }
    if (data.mcpProxy) out.push(<Text key="mcp-proxy" dimColor wrap="truncate-end">* some schema sizes come from a snapshot of another session</Text>);
    if (data.mcpMissing > 0) {
      out.push(
        <Text key="mcp-missing" dimColor wrap="truncate-end">
          {`${data.mcpMissing} ${data.mcpMissing === 1 ? "session has" : "sessions have"} no snapshot, so their schemas are not counted`}
        </Text>,
      );
    }
    out.push(<Text key="mcp-scope" dimColor wrap="truncate-end">schemas: main thread requests; results: main thread and sub-agents</Text>);
    out.push(blank(t, "mcp"));
  }

  if (hidden > 0 || view.more) {
    ctx.more = true;
    out.push(
      <Button key="lists-more" plain dimColor hotkey="m" onPress={() => i.onMore(!view.more)}>
        {view.more ? "fold lists" : `${hidden} more ${hidden === 1 ? "row" : "rows"}`}
      </Button>,
    );
  }
  out.push(
    <Text key="history-note" dimColor wrap="truncate-end">
      ~ estimated from text length
    </Text>,
  );
  return { rows: out, ctx };
}
