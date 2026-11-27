// Breakdown snapshots: the context's makeup taken from the engine while a session is live, kept in the project's
// index folder so a later view of the session (or an older one with no snapshot of its own) can read it back.
// Each live session writes only its own file, so sessions never race on one: the scanner owns the day buckets,
// and a session that lost the lease still takes its snapshot.
import type { EngineInterface } from "claude-code";
import { snapshotOf } from "../core/breakdown.ts";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import { joinPath } from "../core/path.ts";
import { DAY_MS, WINDOW_MS, projectNameOf } from "../core/plan-scan.ts";
import { decodeShard, encodeShard } from "../core/shard.ts";
import type { Shard } from "../core/shard.ts";
import { locate } from "./locate.ts";
import { projectDir } from "./store-index.ts";
import type { StoreEnv } from "./store-index.ts";

type Entry = { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean };
export type SnapshotEnv = StoreEnv & { fs: { list(path: string): Promise<Entry[]> } };
type Tick = () => Promise<void>;
const noTick: Tick = async () => {};

/** Snapshots one session keeps; older ones are dropped as new ones come. */
export const KEEP_PER_SESSION = 8;
/** A live session takes a fresh snapshot after this long. */
export const SNAPSHOT_EVERY_MS = 6 * 3_600_000;
/** Files read at most per load, newest first. */
export const MAX_FILES = 300;

const dirOf = (cfg: string, project: string): string => joinPath(projectDir(cfg, project), "snapshots");
const fileOf = (cfg: string, project: string, sessionId: string): string => joinPath(dirOf(cfg, project), `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "none"}.json`);

const shardOf = (project: string, snapshots: BreakdownSnapshot[]): Shard => ({ v: 1, project, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots });

const isSnapshot = (x: unknown): x is BreakdownSnapshot => typeof x === "object" && x !== null && typeof (x as BreakdownSnapshot).ts === "number" && typeof (x as BreakdownSnapshot).sessionId === "string";

// A torn or foreign file reads as no snapshots: they are an estimate's input, never the record.
function read(text: string): BreakdownSnapshot[] {
  try {
    return decodeShard([text]).snapshots.filter(isSnapshot);
  } catch {
    return [];
  }
}

/** Adds `snap` to its session's file (a snapshot with the same time is replaced); the newest KEEP_PER_SESSION stay. */
export async function saveSnapshot(env: StoreEnv, cfg: string, project: string, snap: BreakdownSnapshot): Promise<void> {
  const path = fileOf(cfg, project, snap.sessionId);
  let have: BreakdownSnapshot[] = [];
  try {
    have = read(await env.fs.read(path, { as: "text" }));
  } catch {
    /* the first snapshot of this session */
  }
  const kept = [...have.filter((x) => x.ts !== snap.ts), snap].sort((a, b) => a.ts - b.ts).slice(-KEEP_PER_SESSION);
  await env.fs.write(path, encodeShard(shardOf(project, kept))[0]!);
}

/** Every snapshot of the project inside the 30-day window, oldest first. Empty when there is no folder yet. */
export async function loadSnapshots(env: SnapshotEnv, cfg: string, project: string, nowMs: number, tick: Tick = noTick): Promise<BreakdownSnapshot[]> {
  let names: Entry[];
  try {
    names = await env.fs.list(dirOf(cfg, project));
  } catch {
    return [];
  }
  const files = names.filter((e) => e.kind === "file" && e.name.endsWith(".json")).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
  const out: BreakdownSnapshot[] = [];
  const from = nowMs - WINDOW_MS - DAY_MS;
  for (const f of files) {
    await tick();
    try {
      for (const s of read(await env.fs.read(joinPath(dirOf(cfg, project), f.name), { as: "text" }))) if (s.ts >= from) out.push(s);
    } catch {
      /* unreadable: skipped */
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// The latest snapshot taken by this process: a fresh install has none in the index until the first write lands.
let latest: BreakdownSnapshot | undefined;
let taking: Promise<BreakdownSnapshot> | undefined;

/** The snapshot this process took last, or undefined. */
export const lastSnapshot = (): BreakdownSnapshot | undefined => latest;

/**
 * Reads the engine's context breakdown for the live session, summary first (local, quick) and then full (counted
 * with the token-count API), and keeps the better one in the project's index folder. A failed full count leaves the
 * summary standing; a failed write still returns the snapshot. Throws only when the engine gives no breakdown.
 */
export async function takeSnapshot($: EngineInterface): Promise<BreakdownSnapshot> {
  const id = await $.session.id();
  const now = await $.clock.now();
  const quick = (await $.session.usage({ breakdown: "summary" })).context.breakdown;
  if (quick === undefined) throw new Error("the engine gave no context breakdown");
  let snap = snapshotOf(id, now, quick);
  latest = snap;
  const where = async (): Promise<{ cfg: string; project: string }> => ({ cfg: (await locate($)).cfg, project: projectNameOf(await $.session.cwd()) });
  const keep = async (s: BreakdownSnapshot): Promise<void> => {
    try {
      const w = await where();
      await saveSnapshot($, w.cfg, w.project, s);
    } catch {
      /* in memory only until the next one */
    }
  };
  await keep(snap);
  try {
    const full = (await $.session.usage({ breakdown: "full" })).context.breakdown;
    if (full !== undefined) {
      snap = snapshotOf(id, now, full);
      latest = snap;
      await keep(snap);
    }
  } catch {
    /* the summary stands */
  }
  return snap;
}

/** `takeSnapshot` unless this session took one lately (or one is under way); never throws. */
export function maybeSnapshot($: EngineInterface, force = false): Promise<void> {
  const work = async (): Promise<void> => {
    try {
      const id = await $.session.id();
      const now = await $.clock.now();
      if (!force && latest !== undefined && latest.sessionId === id && now - latest.ts < SNAPSHOT_EVERY_MS) return;
      if (taking === undefined) {
        taking = takeSnapshot($);
        taking.then(
          () => (taking = undefined),
          () => (taking = undefined),
        );
      }
      await taking;
    } catch {
      /* a snapshot is optional */
    }
  };
  return work();
}
