// Pure aggregation of shard rows into the dimensions the History and Usage views render.
import { DAY_MS, HOUR_MS, hourStart, localDayStart, localHourIndex } from "./time.ts";
import { repoOf } from "./path.ts";
import { bump, dict } from "./dict.ts";
import { cacheUnitPrices, costOf, memoResolver, unitPrices } from "./pricing.ts";
import type { PriceTable } from "./pricing.ts";
import { findRebuildsSteps, ttlModelSteps } from "./cache-life.ts";
import type { Rebuild, TtlModel } from "./cache-life.ts";
import { analyzeFlowSteps, FLOW_ITEMS } from "./flow.ts";
import { usageCollector } from "./usage-detail.ts";
import type { UsageDetail } from "./usage-detail.ts";
import type { BigResult, CompactionEffect, FlowItem, Paste } from "./flow.ts";
import { streamOf } from "./stream.ts";
import type { Shard } from "./shard.ts";
import type { Tokens, ToolUse, UsageRow } from "./types.ts";
import { drain, drainAsync, STEP_ROWS } from "./steps.ts";
import type { Steps } from "./steps.ts";

export type Span = "session" | "24h" | "30d";
export type Money = { usd: number; tokens: Tokens; requests: number };
/** One sub-agent type: conversations (tasks) it ran, tool results they received, and how many of those failed. */
export type SubStats = { tasks: number; results: number; errors: number };
/** Sub-agent runs (one transcript each) in the span; "small" ones wrote under SMALL_RUN_OUTPUT_TOKENS output tokens in all. */
export type SubagentRuns = {
  runs: number;
  small: number;
  /** What the small runs' first requests cost apart from their output: loading the starting context. */
  smallStartupUsd: number;
  byType: Record<string, { runs: number; small: number; startupUsd: number }>;
};
/**
 * Main-thread compactions in the span and the repo filter. `savedTokens`/`savedUsd` add up each compaction's
 * `CompactionEffect` saving (a lower bound: context not carried, priced at the cache-read rate). `ineffective`: the flagged
 * ones, costliest first, top 40. A session's `autoPeak` is the largest context an automatic compaction fired at, `autoCount` how many were automatic.
 */
export type CompactionStats = {
  count: number;
  savedTokens: number;
  savedUsd: number;
  bySession: Record<string, { count: number; savedTokens: number; savedUsd: number; autoPeak?: number; autoCount?: number }>;
  ineffective: CompactionEffect[];
};
export type TopSession = { sessionId: string; repo: string; title?: string; pr?: string; started: number; usd: number; resume: string };
export type Summary = {
  span: Span;
  from: number;
  to: number;
  total: Money;
  main: Money;
  sub: Money;
  fast: Money;
  byModel: Record<string, Money>;
  /** Requests by the effort they ran at; rows without one are left out. */
  byEffort?: Record<string, Money>;
  byRepo: Record<string, Money>;
  bySubType: Record<string, Record<string, Money & { tools: Record<string, number> }>>;
  /** `bySubType`'s types, over their conversations that have a counted request. Tasks need agent ids, so shards from before them count none. */
  subStats: Record<string, SubStats>;
  bySkill: Record<string, Money>;
  byPlugin: Record<string, Money>;
  /** Spend of the requests that called the server, so entries overlap when one request calls several. */
  byMcp: Record<string, Money & { calls: number }>;
  timeline: { bucketMs: number; points: Money[] };
  /** Nearest-rank [p30, p50, p70, p90, max] of token totals per local clock hour, over hours with a request. */
  hourBands: number[];
  topSessions: TopSession[];
  unpriced: string[];
  /** Cache writes of 20k+ tokens after a pause longer than the cache lives, by time. */
  cacheRebuilds: Rebuild[];
  /** Largest prompt per session, across its main thread and sub-agents. */
  peakContext: Record<string, number>;
  /**
   * Context parts by re-read cost, top 40, over the main thread and every sub-agent transcript; a compaction
   * releases the parts before it. Parts merge by source and label across conversations; each sub-agent
   * conversation has its own fixed part, labelled "fixed part (<agent type>)".
   */
  flow: FlowItem[];
  /** `flow` per agent: `main`, `sub:<type>`. */
  flowByAgent: Record<string, FlowItem[]>;
  /** MCP server to the re-read cost of all its tool results (main and sub-agents), not limited to the top-40 `flow`. */
  mcpReread: Record<string, number>;
  /** Where each billed kind went, per agent; only when asked for with `usage`. */
  usage?: UsageDetail;
  /** Prompts of 5000+ tokens by re-read cost, top 40; a sub-agent's task prompt counts too. */
  pastes: Paste[];
  /** File to its most whole reads within one conversation (the main thread or one sub-agent); files read whole at least twice, top 40. */
  wholeReads: Record<string, number>;
  /** Compactions per session. */
  compactions: Record<string, number>;
  /** What the compactions in the span did to the context; always set by `summarize`. */
  compaction?: CompactionStats;
  /** Tokens each tool put into context. */
  toolFill: Record<string, number>;
  /** Tool results of 25k+ tokens by re-read cost, top 40, over the main thread and every sub-agent. */
  hugeResults: BigResult[];
  /** What the main threads' pauses would cost under a 5-minute and under a 1-hour cache. */
  cacheTtl: TtlModel;
  subagentRuns: SubagentRuns;
  /** Per model, the main-thread requests that called tools, and the part of them that only read or searched. */
  mainTools: Record<string, { turns: number; readOnly: Money }>;
};
export type SummaryOpts = {
  span: Span;
  nowMs: number;
  repo?: string;
  /** Minutes east of UTC. */
  tzOffsetMin: number;
  /** "session" span only: the session to summarize; default is the one with the latest request. */
  sessionId?: string;
  /** Also split each billed kind by source (the Usage tab's figures); costs one more pass over the requests. */
  usage?: boolean;
  /** "24h" and "30d" spans: start the window here when later than the span's own start (a recheck looks only at what came after the adoption). */
  since?: number;
};

export const TOP_SESSIONS = 20;
/** A sub-agent run that wrote fewer output tokens than this, over all its requests, is small. */
export const SMALL_RUN_OUTPUT_TOKENS = 500;
/** Tools that change nothing; a request calling only these is a read-only turn (names lower-cased). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "ls", "webfetch", "websearch", "notebookread", "toolsearch"]);
export const isReadOnlyTurn = (tools: ToolUse[]): boolean => tools.length > 0 && tools.every((t) => READ_ONLY_TOOLS.has(t.name.toLowerCase()));
/** A "session" span longer than this many hourly buckets switches to daily buckets. */
export const SESSION_HOURLY_MAX = 72;
export const UNKNOWN_REPO = "unknown";
export const UNKNOWN_SUB = "unknown";

const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 });
const zero = (): Money => ({ usd: 0, tokens: zeroTokens(), requests: 0 });

function add(m: Money, r: UsageRow, usd: number): void {
  m.usd += usd;
  m.requests++;
  const t = m.tokens;
  t.input += r.tokens.input;
  t.output += r.tokens.output;
  t.cacheRead += r.tokens.cacheRead;
  t.cw5m += r.tokens.cw5m;
  t.cw1h += r.tokens.cw1h;
}

// For records made by `dict()`: keys come from data and may be "constructor".
function slot<V>(rec: Record<string, V>, key: string, make: () => V): V {
  if (!(key in rec)) rec[key] = make();
  return rec[key];
}

type Row = { r: UsageRow; usd: number; repo: string };

export const repoFor = (r: UsageRow): string => (r.cwd ? repoOf(r.cwd) || UNKNOWN_REPO : UNKNOWN_REPO);

export function summarize(shards: Shard[], prices: PriceTable, opts: SummaryOpts): Summary {
  return drain(summarySteps(shards, prices, opts));
}

/**
 * Same Summary as `summarize`, computed in steps: `tick` is awaited about every STEP_ROWS rows and between
 * phases, so the caller can hand control back (e.g. through a slicer) instead of blocking for the whole pass.
 */
export function summarizeAsync(shards: Shard[], prices: PriceTable, opts: SummaryOpts, tick: () => Promise<void> | void): Promise<Summary> {
  return drainAsync(summarySteps(shards, prices, opts), tick);
}

function* summarySteps(shards: Shard[], prices: PriceTable, opts: SummaryOpts): Steps<Summary> {
  let n = 0;
  const { span, nowMs, tzOffsetMin } = opts;
  const resolve = memoResolver(prices);

  // Synthetic rows are not API requests. Rows are priced once here.
  const unpriced = new Set<string>();
  let rows: Row[] = [];
  // Every real request, before the repo and window filters: the deep dimensions need the history around a span.
  const everyRow: UsageRow[] = [];
  for (const s of shards) {
    for (const r of s.usage) {
      if (++n % STEP_ROWS === 0) yield;
      if (r.synthetic) continue;
      everyRow.push(r);
      const repo = repoFor(r);
      if (opts.repo !== undefined && repo !== opts.repo) continue;
      const c = costOf(r, prices, resolve);
      rows.push({ r, usd: c.usd, repo });
      if (!c.priced) unpriced.add(r.model);
    }
  }

  // Window and timeline bucketing.
  let from: number;
  let to = nowMs;
  let bucketMs: number;
  let start: number;
  let count: number;
  if (span === "24h") {
    bucketMs = HOUR_MS;
    count = 24;
    start = hourStart(nowMs) - 23 * HOUR_MS;
    from = start;
  } else if (span === "30d") {
    bucketMs = DAY_MS;
    count = 30;
    start = localDayStart(nowMs, tzOffsetMin) - 29 * DAY_MS;
    from = start;
  } else {
    let id = opts.sessionId;
    if (id === undefined) {
      let latest = -Infinity;
      for (const x of rows) if (x.r.ts > latest) ((latest = x.r.ts), (id = x.r.sessionId));
    }
    rows = rows.filter((x) => x.r.sessionId === id);
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of rows) {
      if (x.r.ts < lo) lo = x.r.ts;
      if (x.r.ts > hi) hi = x.r.ts;
    }
    from = rows.length ? lo : nowMs;
    to = rows.length ? hi : nowMs;
    const hours = (hourStart(to) - hourStart(from)) / HOUR_MS + 1;
    if (hours <= SESSION_HOURLY_MAX) {
      bucketMs = HOUR_MS;
      start = hourStart(from);
      count = hours;
    } else {
      bucketMs = DAY_MS;
      start = localDayStart(from, tzOffsetMin);
      count = Math.floor((localDayStart(to, tzOffsetMin) - start) / DAY_MS) + 1;
    }
  }
  if (span !== "session" && opts.since !== undefined) from = Math.max(from, opts.since);
  if (span !== "session") rows = rows.filter((x) => x.r.ts >= from && x.r.ts <= to);

  const out: Summary = {
    span,
    from,
    to,
    total: zero(),
    main: zero(),
    sub: zero(),
    fast: zero(),
    byModel: dict(),
    byEffort: dict(),
    byRepo: dict(),
    bySubType: dict(),
    subStats: dict(),
    bySkill: dict(),
    byPlugin: dict(),
    byMcp: dict(),
    timeline: { bucketMs, points: Array.from({ length: count }, zero) },
    hourBands: [0, 0, 0, 0, 0],
    topSessions: [],
    unpriced: [...unpriced].sort(),
    cacheRebuilds: [],
    peakContext: dict(),
    flow: [],
    flowByAgent: dict(),
    mcpReread: dict(),
    pastes: [],
    wholeReads: dict(),
    compactions: dict(),
    compaction: { count: 0, savedTokens: 0, savedUsd: 0, bySession: dict(), ineffective: [] },
    toolFill: dict(),
    hugeResults: [],
    cacheTtl: { requests: 0, actual: "5m", usd5m: 0, usd1h: 0, pauses: { short: 0, mid: 0, long: 0 } },
    subagentRuns: { runs: 0, small: 0, smallStartupUsd: 0, byType: dict() },
    mainTools: dict(),
  };

  type Acc = { usd: number; started: number; byRepo: Map<string, number> };
  const sessions = new Map<string, Acc>();
  const hourTokens = new Map<number, number>();
  type SubAcc = { type: string; output: number; firstTs: number; startupUsd: number };
  const subs = new Map<string, SubAcc>();
  yield;
  for (const { r, usd, repo } of rows) {
    if (++n % STEP_ROWS === 0) yield;
    add(out.total, r, usd);
    add(r.sidechain ? out.sub : out.main, r, usd);
    if (r.fast) add(out.fast, r, usd);
    add(slot(out.byModel, r.model, zero), r, usd);
    if (r.effort !== undefined) add(slot(out.byEffort!, r.effort, zero), r, usd);
    add(slot(out.byRepo, repo, zero), r, usd);
    if (r.sidechain) {
      const m = slot(slot(out.bySubType, r.agentType ?? UNKNOWN_SUB, () => dict<Money & { tools: Record<string, number> }>()), r.model, () => ({ ...zero(), tools: dict<number>() }));
      add(m, r, usd);
      for (const t of r.tools) bump(m.tools, t.name);
      const key = streamOf(r);
      let acc = subs.get(key);
      if (!acc) subs.set(key, (acc = { type: r.agentType ?? UNKNOWN_SUB, output: 0, firstTs: Infinity, startupUsd: 0 }));
      acc.output += r.tokens.output;
      if (r.ts < acc.firstTs) {
        const u = unitPrices(r, prices, resolve);
        acc.firstTs = r.ts;
        acc.startupUsd = r.tokens.input * u.input + r.tokens.cacheRead * u.read + r.tokens.cw5m * u.cw5m + r.tokens.cw1h * u.cw1h;
      }
    } else if (r.tools.length > 0) {
      const m = slot(out.mainTools, r.model, () => ({ turns: 0, readOnly: zero() }));
      m.turns++;
      if (isReadOnlyTurn(r.tools)) add(m.readOnly, r, usd);
    }
    if (r.skill) add(slot(out.bySkill, r.skill, zero), r, usd);
    if (r.plugin) add(slot(out.byPlugin, r.plugin, zero), r, usd);
    const calls = new Map<string, number>();
    for (const t of r.tools) if (t.mcpServer) calls.set(t.mcpServer, (calls.get(t.mcpServer) ?? 0) + 1);
    for (const [srv, n] of calls) {
      const m = slot(out.byMcp, srv, () => ({ ...zero(), calls: 0 }));
      add(m, r, usd);
      m.calls += n;
    }
    const i = Math.floor((r.ts - start) / bucketMs);
    if (i >= 0 && i < count) add(out.timeline.points[i], r, usd);
    const h = localHourIndex(r.ts, tzOffsetMin);
    hourTokens.set(h, (hourTokens.get(h) ?? 0) + r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cw5m + r.tokens.cw1h);

    let a = sessions.get(r.sessionId);
    if (!a) sessions.set(r.sessionId, (a = { usd: 0, started: r.ts, byRepo: new Map() }));
    a.usd += usd;
    a.started = Math.min(a.started, r.ts);
    a.byRepo.set(repo, (a.byRepo.get(repo) ?? 0) + usd);
  }

  for (const a of subs.values()) {
    const t = slot(out.subagentRuns.byType, a.type, () => ({ runs: 0, small: 0, startupUsd: 0 }));
    out.subagentRuns.runs++;
    t.runs++;
    if (a.output < SMALL_RUN_OUTPUT_TOKENS) {
      out.subagentRuns.small++;
      out.subagentRuns.smallStartupUsd += a.startupUsd;
      t.small++;
      t.startupUsd += a.startupUsd;
    }
  }
  yield;
  if (hourTokens.size) {
    const sorted = [...hourTokens.values()].sort((a, b) => a - b);
    const rank = (pct: number) => sorted[Math.max(1, Math.ceil((pct / 100) * sorted.length)) - 1];
    out.hourBands = [rank(30), rank(50), rank(70), rank(90), sorted[sorted.length - 1]];
  }

  // Titles and PR links: metas are already the latest per session and key.
  const metas = new Map<string, { custom?: string; ai?: string; pr?: string }>();
  for (const s of shards) {
    for (const m of s.metas) {
      if (typeof m.value !== "string" || !sessions.has(m.sessionId)) continue;
      const e = metas.get(m.sessionId) ?? {};
      if (m.key === "custom-title") e.custom = m.value;
      else if (m.key === "ai-title") e.ai = m.value;
      else if (m.key === "pr-link") e.pr = m.value;
      metas.set(m.sessionId, e);
    }
  }
  yield;
  const top: TopSession[] = [];
  for (const [sessionId, a] of sessions) {
    let repo = UNKNOWN_REPO;
    let best = -Infinity;
    for (const [k, v] of a.byRepo) if (v > best) ((best = v), (repo = k));
    const t: TopSession = { sessionId, repo, started: a.started, usd: a.usd, resume: `claude --resume ${sessionId}` };
    const m = metas.get(sessionId);
    const title = m?.custom ?? m?.ai;
    if (title) t.title = title;
    if (m?.pr) t.pr = m.pr;
    top.push(t);
  }
  top.sort((x, y) => y.usd - x.usd || x.started - y.started || (x.sessionId < y.sessionId ? -1 : 1));
  out.topSessions = top.slice(0, TOP_SESSIONS);

  // Deep dimensions: a request is counted when it is one of the summarized rows.
  const counted = new Set<UsageRow>();
  const agentType = new Map<string, string>();
  for (const { r } of rows) {
    if (++n % STEP_ROWS === 0) yield;
    counted.add(r);
    if (r.sidechain && r.agentId !== undefined) agentType.set(`${r.sessionId}\u0000${r.agentId}`, r.agentType ?? UNKNOWN_SUB);
  }
  const users = shards.flatMap((s) => s.users);
  for (const type of agentType.values()) slot(out.subStats, type, () => ({ tasks: 0, results: 0, errors: 0 })).tasks++;
  for (const u of users) {
    if (++n % STEP_ROWS === 0) yield;
    if (u.kind !== "toolResult" || u.agentId === undefined) continue;
    const type = agentType.get(`${u.sessionId}\u0000${u.agentId}`);
    if (type === undefined) continue;
    const st = out.subStats[type]!;
    st.results += u.results?.length ?? 1;
    st.errors += u.errors ?? 0;
  }
  const compacts = shards.flatMap((s) => s.compacts);
  const inWindow = (ts: number) => span === "session" || (ts >= from && ts <= to);
  yield;
  out.cacheRebuilds = yield* findRebuildsSteps(everyRow, (r) => counted.has(r), (r) => {
    const u = cacheUnitPrices(r, prices, resolve);
    return r.tokens.cw5m * u.cw5m + r.tokens.cw1h * u.cw1h;
  });
  yield;
  out.cacheTtl = yield* ttlModelSteps(everyRow, (r) => counted.has(r), (r) => cacheUnitPrices(r, prices, resolve));
  yield;
  const collector = opts.usage === true ? usageCollector(prices) : undefined;
  const flow = yield* analyzeFlowSteps({
    rows: everyRow,
    users,
    compacts,
    counted: (r) => counted.has(r),
    cacheReadUsd: (r) => cacheUnitPrices(r, prices, resolve).read,
    ...(collector !== undefined && { onRequest: collector.add }),
  });
  if (collector !== undefined) out.usage = collector.done();
  out.peakContext = flow.peakContext;
  out.flow = flow.flow;
  out.flowByAgent = flow.byAgent;
  out.mcpReread = flow.mcpReread;
  out.pastes = flow.pastes;
  out.hugeResults = flow.bigResults;
  out.wholeReads = flow.wholeReads;
  out.toolFill = flow.toolFill;
  for (const c of compacts) {
    if (sessions.has(c.sessionId) && inWindow(c.ts)) bump(out.compactions, c.sessionId);
  }
  const stats = out.compaction!;
  for (const e of flow.compactionEffects) {
    if (!sessions.has(e.sessionId) || !inWindow(e.ts)) continue;
    stats.count++;
    stats.savedTokens += e.savedTokens;
    stats.savedUsd += e.savedUsd;
    const s = slot(stats.bySession, e.sessionId, () => ({ count: 0, savedTokens: 0, savedUsd: 0 }));
    s.count++;
    s.savedTokens += e.savedTokens;
    s.savedUsd += e.savedUsd;
    if (e.trigger === "auto") {
      s.autoCount = (s.autoCount ?? 0) + 1;
      if (e.preTokens > (s.autoPeak ?? 0)) s.autoPeak = e.preTokens;
    }
    if (e.ineffective) stats.ineffective.push(e);
  }
  stats.ineffective.sort((a, b) => b.keptUsd - a.keptUsd || a.ts - b.ts || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  stats.ineffective = stats.ineffective.slice(0, FLOW_ITEMS);
  return out;
}
