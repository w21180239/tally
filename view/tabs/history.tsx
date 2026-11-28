// The Spend tab (id `history`): when and where the money went over the span (session, 24h or 30d), for all repos or the
// live session's repo alone. Rows by day (by hour under a day), model, main thread against sub-agents, sub-agent type,
// repo and session; why it cost that much is the Tokens tab. A running transcript scan is named with its percent. With
// a sync folder, `t` shows every computer's 30 days; a block no file carries says "This computer only".
// `drawHistory` returns the rows and the keys they add.
import type { RenderElement } from "claude-code";
import { dayWords, historyKeyOf, hourWords, localDayName, scanText } from "../../core/history.ts";
import type { HistoryData, ScanState } from "../../core/history.ts";
import type { Span } from "../../core/summary.ts";
import { shortModel } from "../../core/usage-detail.ts";
import { headlineOf, moneyColumn, tokensText } from "../data.ts";
import type { WindowData } from "../data.ts";
import { gridOf } from "../grid.ts";
import type { KeyCtx } from "../keys.ts";
import { blank, row, section, status, textLines } from "../rows.tsx";
import type { Table } from "../table.ts";
import { SEP, textBar } from "../theme.ts";

const SCAN_BAR_CELLS = 8;

/** Rows a section lists before `m` opens the rest; the day list shows a week. */
export const SECTION_ROWS = 5;
export const DAYS_SHOWN = 7;
/** A day of hours is 24 rows: eight show, the rest wait behind `m`. */
export const HOURS_SHOWN = 8;
const DETAIL_LINES = 6;

export type HistoryView = { more: boolean; shown: string[] };

export type HistoryInput = {
  d: WindowData;
  data: HistoryData;
  /** With a sync folder: this computer's figures or every computer's (the `t` key). */
  machines?: "this" | "all";
  /** A sync folder is set, so the figures carry the merge. */
  sync?: boolean;
  /** The scan under way, or null. */
  scan: ScanState | null;
  /** The span asked for, and the live session's id (the session span's key). */
  span: Span;
  sessionId: string;
  repoOnly: boolean;
  view: HistoryView;
  onMore: (more: boolean) => void;
  onShown: (key: string) => void;
};

export type HistoryDrawing = { rows: RenderElement[]; ctx: KeyCtx };

/** A session row's key is its id, so an open row stays open however the lists are cut or rebuilt. */
export const sessionRowKey = (sessionId: string): string => `session|${sessionId}`;

const SPAN_WORDS: Record<Span, string> = { session: "this session", "24h": "the past 24 hours", "30d": "the past 30 days" };
export const ONLY_HERE = "This computer only";
export const SOME_MISSING = "Not every computer shares this";

export function drawHistory(t: Table, i: HistoryInput): HistoryDrawing {
  const { Box, Text, Button } = t;
  const { d, view } = i;
  const ctx: KeyCtx = {};
  const out: RenderElement[] = [];
  const want = historyKeyOf(i.repoOnly, i.sync === true, i.span, i.sessionId);
  const words = SPAN_WORDS[i.span];
  // Other computers' files carry days and no per-repo split, so only the all-repo 30 days are merged.
  const merged = i.machines === "all" && !i.repoOnly && i.span === "30d" ? i.data.all : undefined;
  const data: HistoryData = merged ?? i.data;
  // The note a block carries in the all-computers view: nothing when every file fed it.
  const labelOf = (block: string): string | undefined => {
    if (merged === undefined) return undefined;
    return merged.localOnly.includes(block) ? (merged.contributed.includes(block) ? SOME_MISSING : ONLY_HERE) : undefined;
  };
  const noted = (block: string, note?: string): string | undefined => {
    const label = labelOf(block);
    return label === undefined ? note : note === undefined ? label : `${note}${SEP}${label}`;
  };
  // A running scan reads as progress: what is happening, how far, and that the figures are not final.
  const percent = i.scan?.percent ?? null;
  const scanLine: RenderElement[] =
    i.scan === null
      ? []
      : percent === null
        ? [
            <Text key="scan" dimColor wrap="truncate-end">
              {scanText(i.scan)}
            </Text>,
          ]
        : [
            <Box key="scan" flexDirection="row" columnGap={1}>
              <Text>Indexing transcripts</Text>
              <Text>{textBar(percent / 100, SCAN_BAR_CELLS)}</Text>
              <Text>{`${percent}%`}</Text>
              <Text dimColor wrap="truncate-end">figures are still changing</Text>
            </Box>,
          ];

  if (i.span === "session" && i.sessionId === "") return { rows: [status(t, "none", "No session yet.", "Start a conversation and Spend fills in.")], ctx };
  if (data.key !== want) {
    if (data.failure?.key === want) return { rows: [status(t, "failed", `Could not read the index: ${data.failure.why}`, "tally reads it again on the next refresh.")], ctx };
    return { rows: [status(t, "loading", "Reading the index...", "Spend fills in as the transcripts are read. It is safe to keep working."), ...scanLine], ctx };
  }
  const where = i.repoOnly ? ` in ${data.repo}` : "";
  if (data.requests === 0) {
    // No index yet means unknown, not zero.
    if (i.scan !== null || data.unread > 0) {
      return { rows: [status(t, "unknown", `No figures for ${words}${where} yet: the transcripts are not indexed.`, "Spend fills in as projects finish. It is safe to keep working."), ...scanLine], ctx };
    }
    return { rows: [status(t, "empty", `No requests in ${words}${where}.`, i.repoOnly ? "Press r to look at all repos." : i.span === "30d" ? "Spend appears here once a conversation has run." : "Try another time span with s.")], ctx };
  }

  const g = gridOf(t.cols, { tokens: true, money: true, bar: true });
  // One block for every amount in the money column, so the column reads in one unit.
  const money = moneyColumn(d, [
    data.total.usd,
    ...data.days.map((x) => x.usd),
    ...data.models.map((m) => m.usd),
    data.main.usd,
    data.sub.usd,
    ...data.subTypes.map((s) => s.usd),
    ...data.repos.map((r) => r.usd),
    ...data.sessions.map((s) => s.usd),
  ]);
  // One total; why it cost that much (billed kinds, causes) is the Tokens tab.
  out.push(
    <Box key="headline" flexDirection="row" columnGap={1}>
      <Text weight="bold">{headlineOf(d, data.total.usd)}</Text>
      <Text dimColor wrap="truncate-end">{`${tokensText(data.total.tokens)} tokens in ${words}${SEP}${data.requests} ${data.requests === 1 ? "request" : "requests"}${i.repoOnly ? `${SEP}${data.repo}` : ""}`}</Text>
    </Box>,
    <Text key="breakdown-hint" dimColor wrap="truncate-end">
      2 for the breakdown
    </Text>,
    ...scanLine,
  );
  if (merged !== undefined) {
    out.push(
      <Text key="machines-note" dimColor wrap="truncate-end">
        {`All computers${SEP}${merged.machines.join(", ")}`}
      </Text>,
    );
    if (merged.localOnly.includes("hours")) {
      out.push(
        <Text key="machines-hours" dimColor wrap="truncate-end">
          Some computers share fewer days than this window, so older days hold fewer computers.
        </Text>,
      );
    }
  } else if (i.machines === "all" && i.sync === true && (i.repoOnly || i.span !== "30d")) {
    out.push(
      <Text key="machines-repo" dimColor wrap="truncate-end">
        {i.span !== "30d" ? "All computers needs the 30 days span: the other computers' files hold days." : "All computers needs All repos: the other computers' files cannot be cut to one repo."}
      </Text>,
    );
  }
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

  const head = (key: string, name: string, note?: string): RenderElement => section(t, g, { key, name, ...(note !== undefined && { note }) });
  const nested = (key: string, label: string, usd: number, top: number, extra: { tokens?: number } = {}): RenderElement =>
    row(t, g, { key, label, money: money(usd), share: share(usd, top), ...(extra.tokens !== undefined && { tokens: tokensText(extra.tokens) }) });

  const byHour = data.bucket === "hour";
  out.push(head("days", byHour ? "Spend per hour" : "Spend per day", "newest first"));
  const dayTop = topOf(data.days.map((x) => x.usd));
  for (const x of shownOf(data.days, byHour ? HOURS_SHOWN : DAYS_SHOWN)) out.push(nested(`day-${x.day}`, byHour ? hourWords(x.day) : dayWords(x.day), x.usd, dayTop, { tokens: x.tokens }));
  out.push(blank(t, "days"));

  out.push(head("models", "Spend per model"));
  const modelTop = topOf(data.models.map((m) => m.usd));
  for (const m of shownOf(data.models, SECTION_ROWS)) out.push(nested(`model-${m.name}`, shortModel(m.name), m.usd, modelTop, { tokens: m.tokens }));
  out.push(blank(t, "models"));

  out.push(head("split", "Main thread and sub-agents"));
  const splitTop = Math.max(data.main.usd, data.sub.usd);
  out.push(nested("split-main", "Main thread", data.main.usd, splitTop));
  out.push(nested("split-sub", "Sub-agents", data.sub.usd, splitTop));
  out.push(blank(t, "split"));

  if (data.subTypes.length > 0) {
    out.push(head("subtypes", "Sub-agent type and model"));
    const top = topOf(data.subTypes.map((s) => s.usd));
    for (const s of shownOf(data.subTypes, SECTION_ROWS)) out.push(nested(`subtype-${s.type}-${s.model}`, `${s.type}${SEP}${shortModel(s.model)}`, s.usd, top));
    out.push(blank(t, "subtypes"));
  }

  if (!i.repoOnly && data.repos.length > 0) {
    out.push(head("repos", "Spend per repo", noted("byRepo")));
    const top = topOf(data.repos.map((r) => r.usd));
    for (const r of shownOf(data.repos, SECTION_ROWS)) out.push(nested(`repo-${r.name}`, r.name, r.usd, top));
    out.push(blank(t, "repos"));
  }

  if (data.sessions.length > 0) {
    out.push(head("sessions", "Largest sessions", noted("topSessions", "press a row to resume")));
    const top = topOf(data.sessions.map((s) => s.usd));
    for (const s of shownOf(data.sessions, SECTION_ROWS)) {
      const key = sessionRowKey(s.sessionId);
      const name = s.title === undefined || s.title === "" ? s.sessionId.slice(0, 8) : s.title;
      const day = dayWords(localDayName(s.started, -new Date(s.started).getTimezoneOffset()));
      // A session of another computer resumes only there: its machine is named and no resume line is offered.
      const elsewhere = merged?.sessionMachine[s.sessionId];
      out.push(row(t, g, { key, label: `${name}${SEP}${day}${SEP}${s.repo}${elsewhere === undefined ? "" : `${SEP}${elsewhere}`}`, money: money(s.usd), share: share(s.usd, top), onPress: () => i.onShown(key) }));
      ctx.rows = true;
      if (view.shown.includes(key)) {
        const lines = [...(s.title === undefined || s.title === "" ? [] : [s.title]), `session ${s.sessionId}`, ...(s.pr === undefined ? [] : [`PR ${s.pr}`]), elsewhere === undefined ? s.resume : `on ${elsewhere}: resume it there`];
        out.push(textLines(t, `${key}-detail`, lines.join("\n"), DETAIL_LINES));
      }
    }
    out.push(blank(t, "sessions"));
  }

  if (hidden > 0 || view.more) {
    ctx.more = true;
    out.push(
      <Button key="lists-more" plain dimColor hotkey="m" onPress={() => i.onMore(!view.more)}>
        {view.more ? "fold lists" : `${hidden} more ${hidden === 1 ? "row" : "rows"}`}
      </Button>,
    );
  }
  return { rows: out, ctx };
}
