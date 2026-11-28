// What the Usage tab reads: the span's figures split by kind and source, for all agents and for each one, built from
// the index in the background. The tab draws whatever the atom last held and asks for a rebuild when it is stale.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { nearestSnapshot } from "../core/breakdown.ts";
import type { BreakdownSnapshot, McpCost } from "../core/breakdown.ts";
import { mcpCosts } from "../core/history.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import type { Shard } from "../core/shard.ts";
import { STEP_ROWS } from "../core/steps.ts";
import { summarizeAsync } from "../core/summary.ts";
import type { Span } from "../core/summary.ts";
import { stepRow } from "../core/live-state.ts";
import type { LiveState } from "../core/live-state.ts";
import type { UsageRow } from "../core/types.ts";
import { agentLabel, usageAgents, usageDetail, usageTotals, USAGE_KINDS, writeParts } from "../core/usage-detail.ts";
import type { Amount, DetailRow, UsageKind } from "../core/usage-detail.ts";
import { readLive } from "./live.ts";
import { locate } from "./locate.ts";
import { schemaCosts } from "./mcp-cost.ts";
import { currentPrices } from "./price-update.ts";
import { loadProject } from "./project-store.ts";
import { listProjects } from "./scanner.ts";
import { makeSlicer } from "./slicer.ts";
import { lastSnapshot, loadSnapshots } from "./snapshot.ts";
import { invalidateWindow } from "./window.ts";

/** One kind's rows. Cache write keeps its groups in `rows` and the largest single writes in `largest`. */
export type UsageSection = { kind: UsageKind; total: Amount; rows: DetailRow[]; largest?: DetailRow[] };

export type UsageData = {
  /** What the figures are of: `<span>:<session id>` (the id only for the session span). */
  key: string;
  at: number;
  requests: number;
  /** Agents with spend, the main thread first. */
  agents: Array<{ key: string; label: string; usd: number }>;
  /** Sections per agent key; the empty key holds every agent together. */
  by: Record<string, UsageSection[]>;
  /** The breakdown snapshot the fixed part's split rests on; `proxy` when it was taken in another session. */
  snapshot: { ts: number; proxy: boolean } | null;
  /** Tokens each tool put into context over the span (all agents), estimated from text length. */
  fill: Array<{ tool: string; tokens: number }>;
  /** What each MCP server cost over the span: schemas on main requests plus every tool result re-read. */
  mcp: McpCost[];
  /** Some schema sizes rest on another session's snapshot. */
  mcpProxy: boolean;
  /** Sessions with main-thread requests and no snapshot: `mcp` leaves their schemas out. */
  mcpMissing: number;
  /** Set when the last build for `key` failed and none has worked since; the tab shows it instead of waiting. */
  failure?: { key: string; why: string };
};

export const EMPTY_USAGE: UsageData = { key: "", at: 0, requests: 0, agents: [], by: {}, snapshot: null, fill: [], mcp: [], mcpProxy: false, mcpMissing: 0 };

/** Figures older than this are rebuilt when the tab is drawn: the live session's sooner than a span of days. */
export const USAGE_INTERVAL_MS = { session: 10_000, "24h": 300_000, "30d": 300_000 } as const;
/** After a failed build, the next try waits this long. */
export const USAGE_RETRY_MS = 30_000;
/** Agents with figures of their own (the costliest). */
export const AGENT_SECTIONS = 12;
/** A failure's reason is shown cut to this many characters. */
const FAILURE_CHARS = 80;

const usageAtom = atom({ plugin: "tally", key: "usage" } as const, EMPTY_USAGE, { shape: "usage-2" });

export function readUsage($: EngineInterface): Promise<UsageData> {
  return read($, usageAtom);
}

export type UsageWant = { span: Span; sessionId: string };

export const usageKeyOf = (w: Pick<UsageWant, "span" | "sessionId">): string => `${w.span}:${w.span === "session" ? w.sessionId : ""}`;

/** True when the tab should ask for figures: none of this span yet, or older than their interval. */
export function needsUsage(data: Pick<UsageData, "key" | "at">, want: Pick<UsageWant, "span" | "sessionId">, now: number): boolean {
  if (want.span === "session" && want.sessionId === "") return false;
  return data.key !== usageKeyOf(want) || now - data.at >= USAGE_INTERVAL_MS[want.span];
}

type Tick = () => Promise<void>;

// Rows of one session, taken in slices.
async function ownOf<T extends { sessionId: string }>(rows: T[], id: string, tick: Tick): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (i % STEP_ROWS === STEP_ROWS - 1) await tick();
    if (rows[i]!.sessionId === id) out.push(rows[i]!);
  }
  return out;
}

const sectionsOf = (s: Parameters<typeof usageDetail>[0], agent: string | undefined, snap: BreakdownSnapshot | null, tzOffsetMin: number): UsageSection[] =>
  USAGE_KINDS.map((kind): UsageSection => {
    const opts = { snap, tzOffsetMin };
    const total = usageTotals(s, kind, agent);
    if (kind === "cacheWrite") {
      const w = writeParts(s, agent, opts);
      return { kind, total, rows: w.groups, largest: w.largest };
    }
    return { kind, total, rows: usageDetail(s, kind, agent, opts) };
  });

/**
 * The session's rows with this launch's requests taken from the live tally when the index has not caught up with it:
 * the index's rows from before the launch, plus one row per live request (the launch's tokens per model shared out
 * evenly; the live tally holds no per-request figures, and sub-agent requests count as the main thread's). Once the
 * index holds as many of the launch's requests as the live tally does, its own rows stand.
 */
export function withLive(own: UsageRow[], live: Pick<LiveState, "sessionId" | "startedAt" | "stepped">, now: number): UsageRow[] {
  const since = own.filter((r) => r.ts >= live.startedAt).length;
  const models = Object.entries(live.stepped).filter(([, m]) => m.requests > 0);
  const total = models.reduce((n, [, m]) => n + m.requests, 0);
  if (since >= total) return own;
  const out = own.filter((r) => r.ts < live.startedAt);
  const ts = Math.max(now, live.startedAt);
  for (const [model, m] of models) {
    const n = m.requests;
    for (let i = 0; i < n; i++) {
      const part = (v: number): number => Math.floor(v / n) + (i === 0 ? v % n : 0);
      const t = m.tokens;
      const tokens = { input: part(t.input), output: part(t.output), cacheRead: part(t.cacheRead), cw5m: part(t.cw5m), cw1h: part(t.cw1h) };
      out.push({ ...stepRow(live.sessionId, ts, undefined, model, tokens), requestId: `live-${model}-${i}` });
    }
  }
  return out;
}

/**
 * One session's rows of its project as a Shard, with this launch's requests taken from the live tally while the index
 * has not caught up (`withLive`). A session no index holds yet gives a shard of the live requests alone.
 */
export async function sessionShard($: EngineInterface, cfg: string, project: string, id: string, now: number, tick: Tick): Promise<Shard> {
  const shard = await loadProject($, cfg, project, now, tick);
  const own = shard === null ? [] : await ownOf(shard.usage, id, tick);
  const live = await readLive($).catch(() => undefined);
  return {
    v: 1,
    project,
    files: {},
    usage: live !== undefined && live.sessionId === id ? withLive(own, live, now) : own,
    users: shard === null ? [] : await ownOf(shard.users, id, tick),
    metas: [],
    compacts: shard === null ? [] : await ownOf(shard.compacts, id, tick),
    snapshots: [],
  };
}

let builtAt = 0;
let builtKey = "";
let failedAt = 0;
let failedKey = "";
let running: Promise<void> | undefined;

async function build($: EngineInterface, want: UsageWant, now: number): Promise<void> {
  const loc = await locate($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const prices = await currentPrices($);
  const project = projectNameOf(await $.session.cwd());
  const tzOffsetMin = -new Date(now).getTimezoneOffset();
  const isSession = want.span === "session";
  let shards: Shard[] = [];

  if (isSession) {
    shards = [await sessionShard($, loc.cfg, project, want.sessionId, now, tick)];
  } else {
    for (const p of await listProjects($, loc.roots)) {
      await tick();
      const shard = await loadProject($, loc.cfg, p, now, tick);
      if (shard !== null) shards.push(shard);
    }
  }
  const summary = await summarizeAsync(shards, prices, { span: want.span, nowMs: now, tzOffsetMin, usage: true, ...(isSession && { sessionId: want.sessionId }) }, tick);

  // Snapshots of every project in the span (the schema cost needs each one's), and of the live session's project.
  const snapsOf = new Map<string, BreakdownSnapshot[]>();
  for (const p of new Set([project, ...shards.map((s) => s.project)])) {
    await tick();
    snapsOf.set(p, await loadSnapshots($, loc.cfg, p, now, tick));
  }
  const snaps = snapsOf.get(project)!;
  const mine = lastSnapshot();
  if (mine !== undefined && !snaps.some((s) => s.sessionId === mine.sessionId && s.ts === mine.ts)) snaps.push(mine);
  const near = nearestSnapshot(snaps, isSession && summary.total.requests > 0 ? summary.from : summary.to, isSession ? want.sessionId : undefined);
  const snap = near?.snap ?? null;
  const schema = await schemaCosts(prices, shards, (p) => snapsOf.get(p) ?? [], summary.from, summary.to, "", tick);

  const agents = usageAgents(summary).slice(0, AGENT_SECTIONS + 1);
  const by: UsageData["by"] = { "": sectionsOf(summary, undefined, snap, tzOffsetMin) };
  for (const a of agents) by[a.key] = sectionsOf(summary, a.key, snap, tzOffsetMin);
  const data: UsageData = {
    key: usageKeyOf(want),
    at: now,
    requests: summary.total.requests,
    agents: agents.map((a) => ({ key: a.key, label: agentLabel(a.key), usd: a.usd })),
    by,
    snapshot: near === null ? null : { ts: near.snap.ts, proxy: near.proxy },
    fill: Object.entries(summary.toolFill)
      .filter(([, tokens]) => tokens > 0)
      .map(([tool, tokens]) => ({ tool, tokens }))
      .sort((a, b) => b.tokens - a.tokens || (a.tool < b.tool ? -1 : 1)),
    mcp: mcpCosts(schema.usd, summary.mcpReread, summary.byMcp),
    mcpProxy: schema.proxy,
    mcpMissing: schema.missing,
  };
  await update($, usageAtom, () => data);
  invalidateWindow($);
}

/**
 * Rebuilds the figures for `want` unless they are fresh (or `force`), one build at a time. A failed build is not
 * retried for USAGE_RETRY_MS. Never rejects.
 */
export async function refreshUsage($: EngineInterface, want: UsageWant, force = false): Promise<void> {
  try {
    if (want.span === "session" && want.sessionId === "") return;
    const key = usageKeyOf(want);
    const now = await $.clock.now();
    // A build that starts during the read below sends the loop back to wait for it.
    for (;;) {
      while (running !== undefined) await running;
      // The stored figures decide, not this module's memory of its last build: a /clear starts the stored state over.
      const stored = await read($, usageAtom);
      if (running !== undefined) continue;
      if (!force && builtKey === key && now - builtAt < USAGE_INTERVAL_MS[want.span] && stored.key === key) return;
      if (!force && failedKey === key && now - failedAt < USAGE_RETRY_MS) return;
      break;
    }
    // No await between the checks above and this line: only one build starts.
    running = build($, want, now)
      .then(() => {
        builtKey = key;
        builtAt = now;
        failedKey = "";
      })
      .catch(async (err: unknown) => {
        failedKey = key;
        failedAt = now;
        const why = (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0]!.slice(0, FAILURE_CHARS);
        try {
          $.ui.log(`tally: usage build failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, { to: "debug" });
          await update($, usageAtom, (d) => ({ ...d, failure: { key, why } }));
        } catch {
          /* nothing to log to */
        }
      })
      .finally(() => {
        running = undefined;
      });
    await running;
  } catch {
    /* the tab keeps what it had */
  }
}
