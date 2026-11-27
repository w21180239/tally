// Pure aggregation of shard rows into the dimensions the History and Usage views render.
import { DAY_MS, HOUR_MS, hourStart, localDayStart, localHourIndex } from "./time.ts";
import { repoOf } from "./path.ts";
import { cacheUnitPrices, costOf } from "./pricing.ts";
import type { PriceTable } from "./pricing.ts";
import { findRebuilds } from "./cache-life.ts";
import type { Rebuild } from "./cache-life.ts";
import { analyzeFlow } from "./flow.ts";
import type { FlowItem, Paste } from "./flow.ts";
import type { Shard } from "./shard.ts";
import type { Tokens, UsageRow } from "./types.ts";

export type Span = "session" | "24h" | "30d";
export type Money = { usd: number; tokens: Tokens; requests: number };
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
  byRepo: Record<string, Money>;
  bySubType: Record<string, Record<string, Money & { tools: Record<string, number> }>>;
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
  /** Largest main-thread prompt per session. */
  peakContext: Record<string, number>;
  /** Main-thread context parts by re-read cost, top 40; a compaction releases the parts before it. */
  flow: FlowItem[];
  /** Prompts of 5000+ tokens by re-read cost, top 40. */
  pastes: Paste[];
  /** File to its whole-read count in one conversation; files read whole at least twice, top 40. */
  wholeReads: Record<string, number>;
  /** Compactions per session. */
  compactions: Record<string, number>;
  /** Tokens each tool put into context. */
  toolFill: Record<string, number>;
};
export type SummaryOpts = {
  span: Span;
  nowMs: number;
  repo?: string;
  /** Minutes east of UTC. */
  tzOffsetMin: number;
  /** "session" span only: the session to summarize; default is the one with the latest request. */
  sessionId?: string;
};

export const TOP_SESSIONS = 20;
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

function slot<V>(rec: Record<string, V>, key: string, make: () => V): V {
  if (!Object.prototype.hasOwnProperty.call(rec, key)) rec[key] = make();
  return rec[key];
}

type Row = { r: UsageRow; usd: number; repo: string };

const repoFor = (r: UsageRow): string => (r.cwd ? repoOf(r.cwd) || UNKNOWN_REPO : UNKNOWN_REPO);

export function summarize(shards: Shard[], prices: PriceTable, opts: SummaryOpts): Summary {
  const { span, nowMs, tzOffsetMin } = opts;

  // Synthetic rows are not API requests. Rows are priced once here.
  const unpriced = new Set<string>();
  let rows: Row[] = [];
  // Every real request, before the repo and window filters: the deep dimensions need the history around a span.
  const everyRow: UsageRow[] = [];
  for (const s of shards) {
    for (const r of s.usage) {
      if (r.synthetic) continue;
      everyRow.push(r);
      const repo = repoFor(r);
      if (opts.repo !== undefined && repo !== opts.repo) continue;
      const c = costOf(r, prices);
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
  if (span !== "session") rows = rows.filter((x) => x.r.ts >= from && x.r.ts <= to);

  const out: Summary = {
    span,
    from,
    to,
    total: zero(),
    main: zero(),
    sub: zero(),
    fast: zero(),
    byModel: {},
    byRepo: {},
    bySubType: {},
    bySkill: {},
    byPlugin: {},
    byMcp: {},
    timeline: { bucketMs, points: Array.from({ length: count }, zero) },
    hourBands: [0, 0, 0, 0, 0],
    topSessions: [],
    unpriced: [...unpriced].sort(),
    cacheRebuilds: [],
    peakContext: {},
    flow: [],
    pastes: [],
    wholeReads: {},
    compactions: {},
    toolFill: {},
  };

  type Acc = { usd: number; started: number; byRepo: Map<string, number> };
  const sessions = new Map<string, Acc>();
  const hourTokens = new Map<number, number>();
  for (const { r, usd, repo } of rows) {
    add(out.total, r, usd);
    add(r.sidechain ? out.sub : out.main, r, usd);
    if (r.fast) add(out.fast, r, usd);
    add(slot(out.byModel, r.model, zero), r, usd);
    add(slot(out.byRepo, repo, zero), r, usd);
    if (r.sidechain) {
      const m = slot(slot(out.bySubType, r.agentType ?? UNKNOWN_SUB, () => ({})), r.model, () => ({ ...zero(), tools: {} as Record<string, number> }));
      add(m, r, usd);
      for (const t of r.tools) m.tools[t.name] = (m.tools[t.name] ?? 0) + 1;
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
  for (const { r } of rows) counted.add(r);
  const users = shards.flatMap((s) => s.users);
  const compacts = shards.flatMap((s) => s.compacts);
  const inWindow = (ts: number) => span === "session" || (ts >= from && ts <= to);
  out.cacheRebuilds = findRebuilds(everyRow, (r) => counted.has(r), (r) => {
    const u = cacheUnitPrices(r, prices);
    return r.tokens.cw5m * u.cw5m + r.tokens.cw1h * u.cw1h;
  });
  const flow = analyzeFlow({
    rows: everyRow,
    users,
    compacts,
    counted: (r) => counted.has(r),
    countedUser: (u) => sessions.has(u.sessionId) && inWindow(u.ts),
    cacheReadUsd: (r) => cacheUnitPrices(r, prices).read,
  });
  out.peakContext = flow.peakContext;
  out.flow = flow.flow;
  out.pastes = flow.pastes;
  out.wholeReads = flow.wholeReads;
  out.toolFill = flow.toolFill;
  for (const c of compacts) {
    if (sessions.has(c.sessionId) && inWindow(c.ts)) out.compactions[c.sessionId] = (out.compactions[c.sessionId] ?? 0) + 1;
  }
  return out;
}
