// What the Session tab reads beyond the live tally: the spend after each skill, and what each MCP server cost
// (its resident schemas re-read on every main request, plus its tool results re-read). Built from the project's
// index and the nearest breakdown snapshot, in the background; the tab draws whatever the atom last held.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { mcpResultUsd, mcpSchemaSteps, nearestSnapshot } from "../core/breakdown.ts";
import type { LiveState } from "../core/live-state.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { drainAsync } from "../core/steps.ts";
import type { Shard } from "../core/shard.ts";
import { summarizeAsync } from "../core/summary.ts";
import { locate } from "./locate.ts";
import { loadProject } from "./project-store.ts";
import { makeSlicer } from "./slicer.ts";
import { lastSnapshot, loadSnapshots, maybeSnapshot } from "./snapshot.ts";
import { inBackground, invalidateWindow } from "./window.ts";

export type SessionData = {
  /** Whose figures these are: the tab draws them only while that session is the live one. */
  sessionId: string;
  at: number;
  /** Spend of the requests after each skill call, costliest first. */
  skills: Array<{ name: string; usd: number }>;
  /** MCP servers by cost: resident schemas and tool results re-read, and how many calls were made. */
  mcp: Array<{ server: string; usd: number; schemaUsd: number; resultUsd: number; calls: number }>;
  /** The breakdown snapshot the schema figures rest on; `proxy` when it was taken in another session. */
  snapshot: { ts: number; proxy: boolean } | null;
};

export const EMPTY_SESSION: SessionData = { sessionId: "", at: 0, skills: [], mcp: [], snapshot: null };

/** The figures are rebuilt from the index at most this often. */
export const SESSION_INTERVAL_MS = 300_000;

const sessionAtom = atom({ plugin: "tally", key: "session" } as const, EMPTY_SESSION, { shape: "session-1" });

export function readSession($: EngineInterface): Promise<SessionData> {
  return read($, sessionAtom);
}

let builtAt = 0;
let builtFor = "";
let running: Promise<void> | undefined;

async function build($: EngineInterface, live: Pick<LiveState, "sessionId" | "startedAt">, now: number): Promise<void> {
  const id = live.sessionId;
  const loc = await locate($);
  const project = projectNameOf(await $.session.cwd());
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const shard = await loadProject($, loc.cfg, project, now, tick);
  const snaps = await loadSnapshots($, loc.cfg, project, now, tick);
  const mine = lastSnapshot();
  // The snapshot this process took for the session stands in until its file can be read back.
  if (mine !== undefined && mine.sessionId === id && !snaps.some((s) => s.sessionId === mine.sessionId && s.ts === mine.ts)) snaps.push(mine);

  // Only this session's rows: the summary and the context flow are per session, and a project holds many.
  const own: Shard = {
    v: 1,
    project,
    files: {},
    usage: shard === null ? [] : shard.usage.filter((r) => r.sessionId === id),
    users: shard === null ? [] : shard.users.filter((u) => u.sessionId === id),
    metas: shard === null ? [] : shard.metas.filter((m) => m.sessionId === id),
    compacts: shard === null ? [] : shard.compacts.filter((c) => c.sessionId === id),
    snapshots: [],
  };
  const rows = own.usage;
  const summary = await summarizeAsync([own], BUILTIN_PRICES, { span: "session", nowMs: now, tzOffsetMin: -new Date(now).getTimezoneOffset(), sessionId: id }, tick);

  const near = nearestSnapshot(snaps, rows.length > 0 ? summary.from : live.startedAt, id);
  const schema = near === null ? {} : await drainAsync(mcpSchemaSteps(rows, near.snap, BUILTIN_PRICES), tick);
  const results = mcpResultUsd(summary.flow);
  const servers = new Set([...Object.keys(schema), ...Object.keys(results), ...Object.keys(summary.byMcp)]);
  const mcp: SessionData["mcp"] = [];
  for (const server of servers) {
    const schemaUsd = (schema as Record<string, number>)[server] ?? 0;
    const resultUsd = results[server] ?? 0;
    const calls = summary.byMcp[server]?.calls ?? 0;
    if (schemaUsd + resultUsd > 0 || calls > 0) mcp.push({ server, usd: schemaUsd + resultUsd, schemaUsd, resultUsd, calls });
  }
  mcp.sort((a, b) => b.usd - a.usd || (a.server < b.server ? -1 : 1));
  const skills = Object.entries(summary.bySkill)
    .map(([name, m]) => ({ name, usd: m.usd }))
    .sort((a, b) => b.usd - a.usd || (a.name < b.name ? -1 : 1));
  const data: SessionData = { sessionId: id, at: now, skills, mcp, snapshot: near === null ? null : { ts: near.snap.ts, proxy: near.proxy } };
  await update($, sessionAtom, () => data);
  invalidateWindow($);
}

/**
 * Rebuilds the Session tab's figures for `live`'s session: at most once per SESSION_INTERVAL_MS for one session unless
 * `force`, one at a time. Never rejects.
 */
export async function refreshSession($: EngineInterface, live: Pick<LiveState, "sessionId" | "startedAt">, force = false): Promise<void> {
  try {
    if (live.sessionId === "") return;
    const now = await $.clock.now();
    if (!force && builtFor === live.sessionId && now - builtAt < SESSION_INTERVAL_MS) return;
    if (running !== undefined) {
      await running;
      return;
    }
    builtAt = now;
    builtFor = live.sessionId;
    running = build($, live, now).finally(() => {
      running = undefined;
    });
    await running;
  } catch {
    // The tab keeps what it had, and the next call tries again.
    builtAt = 0;
  }
}

/** Session start: a snapshot of the context, then the tab's figures, off the caller's path. */
export function startSessionView($: EngineInterface, live: Pick<LiveState, "sessionId" | "startedAt">): void {
  inBackground($, async () => {
    await maybeSnapshot($, true);
    await refreshSession($, live, true);
  });
}
