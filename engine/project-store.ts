import type { Shard } from "../core/shard.ts";
import { joinPath } from "../core/path.ts";
import { DAY_MS, WINDOW_MS } from "../core/plan-scan.ts";
import { loadAt, loadAtSeq, projectDir, saveAt } from "./store-index.ts";
import type { StoreEnv } from "./store-index.ts";

// A project's index is a manifest plus buckets, each an A/B store of its own:
//   <projectDir>/            manifest: {days: {bucket: seq}}, the commit point
//   <projectDir>/d-<date>/   one UTC day: rows by ts, file states and meta rows by the file's mtime
// A save writes the dirty buckets first and the manifest last. The manifest pins the seq of every
// bucket it expects, and a bucket keeps its previous generation in the other slot, so a reader
// either gets the exact set of generations the manifest names or finds one missing. A missing or
// damaged bucket makes the whole project "corrupt": callers re-read it from the transcripts. A
// bucket from a newer, uncommitted save is never read, so data from two saves is never mixed.

type Tick = () => Promise<void>;
const noTick: Tick = async () => {};

export const dayIdx = (ts: number): number => Math.floor(ts / DAY_MS);
export const dayKey = (idx: number): string => new Date(idx * DAY_MS).toISOString().slice(0, 10);
const idxOfKey = (key: string): number => Math.floor(Date.parse(`${key}T00:00:00Z`) / DAY_MS);

const nameOf = (project: string, key: string) => `${project}#${key}`;
const dirOfBucket = (cfg: string, project: string, key: string) => joinPath(projectDir(cfg, project), `d-${key}`);

export type Loaded =
  | { kind: "empty" }
  | { kind: "corrupt" }
  | { kind: "ok"; days: Map<number, Shard>; seqs: Record<string, number> };

/** Manifest plus every bucket inside the 30-day window; older days are skipped. */
export async function loadBuckets(env: StoreEnv, cfg: string, project: string, nowMs: number, tick: Tick = noTick): Promise<Loaded> {
  const manifest = await loadAt(env, projectDir(cfg, project), project, tick);
  if (!manifest) return { kind: "empty" };
  const cut = dayIdx(nowMs - WINDOW_MS);
  const days = new Map<number, Shard>();
  const seqs: Record<string, number> = {};
  for (const [key, seq] of Object.entries(manifest.days ?? {})) {
    const idx = idxOfKey(key);
    if (Number.isNaN(idx) || idx < cut) continue;
    const b = await loadAtSeq(env, dirOfBucket(cfg, project, key), nameOf(project, key), seq, tick);
    if (!b) return { kind: "corrupt" };
    seqs[key] = seq;
    days.set(idx, b);
  }
  return { kind: "ok", days, seqs };
}

export type SavePlan = { days: Map<number, Shard> };

const isEmpty = (s: Shard) => s.usage.length + s.users.length + s.metas.length + s.compacts.length + Object.keys(s.files).length === 0;

/** Writes the planned buckets, then the manifest. An empty bucket is removed from the manifest. */
export async function saveBuckets(
  env: StoreEnv,
  cfg: string,
  project: string,
  plan: SavePlan,
  seqs: Record<string, number>,
  nowMs: number,
  tick: Tick = noTick,
): Promise<{ seqs: Record<string, number>; dropped: number }> {
  const cut = dayIdx(nowMs - WINDOW_MS);
  const next: Record<string, number> = {};
  for (const [key, seq] of Object.entries(seqs)) if (idxOfKey(key) >= cut) next[key] = seq;
  let dropped = 0;
  const put = async (key: string, shard: Shard) => {
    if (isEmpty(shard)) {
      delete next[key];
      return;
    }
    const r = await saveAt(env, dirOfBucket(cfg, project, key), { ...shard, project: nameOf(project, key) }, tick, seqs[key] ?? 0);
    next[key] = r.seq;
    dropped += r.dropped;
  };
  for (const idx of [...plan.days.keys()].sort((a, b) => a - b)) await put(dayKey(idx), plan.days.get(idx)!);
  const manifest: Shard = { v: 1, project, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [], days: next };
  const r = await saveAt(env, projectDir(cfg, project), manifest, tick);
  dropped += r.dropped;
  return { seqs: next, dropped };
}

/** The whole project as one Shard (window days only); null when there is no usable index. */
export async function loadProject(env: StoreEnv, cfg: string, project: string, nowMs: number, tick: Tick = noTick): Promise<Shard | null> {
  const l = await loadBuckets(env, cfg, project, nowMs, tick);
  if (l.kind !== "ok") return null;
  const out: Shard = { v: 1, project, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
  const metas = new Map<string, Shard["metas"][number]>();
  for (const idx of [...l.days.keys()].sort((a, b) => a - b)) {
    const b = l.days.get(idx)!;
    for (const m of b.metas) metas.set(`${m.sessionId}\0${m.key}`, m);
    Object.assign(out.files, b.files);
    out.usage.push(...b.usage);
    out.users.push(...b.users);
    out.compacts.push(...b.compacts);
  }
  out.metas = [...metas.values()];
  return out;
}
