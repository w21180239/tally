// What the Usage tab reads: the span's figures split by kind and source, for all agents and for each one, built from
// the index in the background. The tab draws whatever the atom last held and asks for a rebuild when it is stale.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { nearestSnapshot } from "../core/breakdown.ts";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import type { Shard } from "../core/shard.ts";
import { STEP_ROWS } from "../core/steps.ts";
import { summarizeAsync } from "../core/summary.ts";
import type { Span } from "../core/summary.ts";
import { agentLabel, usageAgents, usageDetail, usageTotals, USAGE_KINDS, writeParts } from "../core/usage-detail.ts";
import type { Amount, DetailRow, UsageKind } from "../core/usage-detail.ts";
import { locate } from "./locate.ts";
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
};

export const EMPTY_USAGE: UsageData = { key: "", at: 0, requests: 0, agents: [], by: {}, snapshot: null };

/** Figures older than this are rebuilt when the tab is drawn: the live session's sooner than a span of days. */
export const USAGE_INTERVAL_MS = { session: 60_000, "24h": 300_000, "30d": 300_000 } as const;
/** After a failed build, the next try waits this long. */
export const USAGE_RETRY_MS = 30_000;
/** Agents with figures of their own (the costliest). */
export const AGENT_SECTIONS = 12;

const usageAtom = atom({ plugin: "tally", key: "usage" } as const, EMPTY_USAGE, { shape: "usage-1" });

export function readUsage($: EngineInterface): Promise<UsageData> {
  return read($, usageAtom);
}

export type UsageWant = { span: Span; sessionId: string; startedAt?: number };

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

let builtAt = 0;
let builtKey = "";
let failedAt = 0;
let failedKey = "";
let running: Promise<void> | undefined;

async function build($: EngineInterface, want: UsageWant, now: number): Promise<void> {
  const loc = await locate($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const project = projectNameOf(await $.session.cwd());
  const tzOffsetMin = -new Date(now).getTimezoneOffset();
  const isSession = want.span === "session";
  let shards: Shard[] = [];
  let sessionOnly: Shard | undefined;

  if (isSession) {
    const shard = await loadProject($, loc.cfg, project, now, tick);
    if (shard !== null) {
      const id = want.sessionId;
      sessionOnly = {
        v: 1,
        project,
        files: {},
        usage: await ownOf(shard.usage, id, tick),
        users: await ownOf(shard.users, id, tick),
        metas: [],
        compacts: await ownOf(shard.compacts, id, tick),
        snapshots: [],
      };
      shards = [sessionOnly];
    }
  } else {
    for (const p of await listProjects($, loc.roots)) {
      await tick();
      const shard = await loadProject($, loc.cfg, p, now, tick);
      if (shard !== null) shards.push(shard);
    }
  }
  const summary = await summarizeAsync(shards, BUILTIN_PRICES, { span: want.span, nowMs: now, tzOffsetMin, usage: true, ...(isSession && { sessionId: want.sessionId }) }, tick);

  const snaps = await loadSnapshots($, loc.cfg, project, now, tick);
  const mine = lastSnapshot();
  if (mine !== undefined && !snaps.some((s) => s.sessionId === mine.sessionId && s.ts === mine.ts)) snaps.push(mine);
  const near = nearestSnapshot(snaps, isSession && summary.total.requests > 0 ? summary.from : summary.to, isSession ? want.sessionId : undefined);
  const snap = near?.snap ?? null;

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
    while (running !== undefined) await running;
    if (!force && builtKey === key && now - builtAt < USAGE_INTERVAL_MS[want.span]) return;
    if (!force && failedKey === key && now - failedAt < USAGE_RETRY_MS) return;
    // No await between the checks above and this line: only one build starts.
    running = build($, want, now)
      .then(() => {
        builtKey = key;
        builtAt = now;
        failedKey = "";
      })
      .catch(() => {
        failedKey = key;
        failedAt = now;
      })
      .finally(() => {
        running = undefined;
      });
    await running;
  } catch {
    /* the tab keeps what it had */
  }
}
