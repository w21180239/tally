import type { FsReadCall } from "claude-code";
import { decodeShardAsync, encodeShardAsync, readHeader } from "../core/shard.ts";
import type { Shard } from "../core/shard.ts";
import { joinPath } from "../core/path.ts";

export type StoreEnv = { fs: { read: FsReadCall; write(path: string, text: string): Promise<void> } };

// FNV-1a over UTF-16 units with two seeds: 16 hex chars, pure JS.
function hash16(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  return a.toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

// Deterministic, filesystem-safe (Windows included): sanitized prefix plus a hash of the full name.
export function projectKey(project: string): string {
  const safe = project.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 40);
  return `${safe}-${hash16(project)}`;
}

const dirOf = (cfg: string, project: string) => joinPath(cfg, "tally", "index", projectKey(project));

type Slot = "A" | "B";
type Head = { seq: number; nonce: string; slot: Slot; parts: number };
type Found = { shard: Shard; seq: number; slot: Slot };
type Tick = () => Promise<void>;
const noTick: Tick = async () => {};

async function readHead(env: StoreEnv, dir: string): Promise<Head | null> {
  try {
    const h = JSON.parse(await env.fs.read(joinPath(dir, "HEAD.json"), { as: "text" })) as Head;
    const ok = (h.slot === "A" || h.slot === "B") && Number.isInteger(h.parts) && h.parts >= 1 && typeof h.seq === "number" && typeof h.nonce === "string";
    return ok ? h : null;
  } catch {
    return null;
  }
}

// A slot is valid only when all its parts belong to one save under `name`; `want` (from HEAD) also pins seq/nonce/n,
// `seq` pins the save counter alone.
async function readSlot(env: StoreEnv, dir: string, slot: Slot, name: string, tick: Tick, want?: Head, seq?: number): Promise<Found | null> {
  try {
    const p0 = await env.fs.read(joinPath(dir, `${slot}-0.json`), { as: "text" });
    const hd = readHeader(p0);
    if (!hd || hd.project !== name) return null;
    if (want && (hd.seq !== want.seq || hd.nonce !== want.nonce || hd.n !== want.parts)) return null;
    if (seq !== undefined && hd.seq !== seq) return null;
    const parts = [p0];
    for (let i = 1; i < hd.n; i++) {
      await tick();
      parts.push(await env.fs.read(joinPath(dir, `${slot}-${i}.json`), { as: "text" }));
    }
    return { shard: await decodeShardAsync(parts, tick), seq: hd.seq, slot };
  } catch {
    return null;
  }
}

// HEAD is the fast path; when it is missing, torn or its slot is inconsistent, probe both slots
// and take the valid one with the highest seq. null only when neither slot is valid.
async function best(env: StoreEnv, dir: string, name: string, tick: Tick): Promise<Found | null> {
  const head = await readHead(env, dir);
  if (head) {
    const f = await readSlot(env, dir, head.slot, name, tick, head);
    if (f) return f;
  }
  const a = await readSlot(env, dir, "A", name, tick);
  const b = await readSlot(env, dir, "B", name, tick);
  if (a && b) return a.seq >= b.seq ? a : b;
  return a ?? b;
}

export async function loadShard(env: StoreEnv, cfg: string, project: string, tick: Tick = noTick): Promise<Shard | null> {
  return (await best(env, dirOf(cfg, project), project, tick))?.shard ?? null;
}

/** Newest valid save under `dir`, stored under header name `name`. */
export async function loadAt(env: StoreEnv, dir: string, name: string, tick: Tick = noTick): Promise<Shard | null> {
  return (await best(env, dir, name, tick))?.shard ?? null;
}

/** The save with exactly this counter (either slot), or null when it is gone or damaged. */
export async function loadAtSeq(env: StoreEnv, dir: string, name: string, seq: number, tick: Tick = noTick): Promise<Shard | null> {
  const head = await readHead(env, dir);
  if (head?.seq === seq) {
    const f = await readSlot(env, dir, head.slot, name, tick, head);
    if (f) return f.shard;
  }
  const other: Slot = head?.slot === "A" ? "B" : "A";
  const slots: Slot[] = head ? [other] : ["A", "B"];
  for (const slot of slots) {
    const f = await readSlot(env, dir, slot, name, tick, undefined, seq);
    if (f) return f.shard;
  }
  return null;
}

// $.fs has no delete, so two slots A/B alternate: write the slot that does not hold the newest save
// (all parts first, then HEAD). Parts carry {seq, nonce, i, n}, so a reader rejects a slot mixed
// from two concurrent saves; leftover extra parts are ignored because n says how many to read.
// A valid HEAD names the newest save without reading it; otherwise both slots are probed.
// `committed` is the seq a manifest names for this store (0 = none). A newer save than that is uncommitted:
// its slot is overwritten, because the other slot holds the committed generation. Without `committed` the
// newest save counts as committed.
// Returns the new seq and the number of rows dropped for exceeding the part limit on their own.
export async function saveAt(env: StoreEnv, dir: string, shard: Shard, tick: Tick = noTick, committed?: number): Promise<{ dropped: number; seq: number }> {
  const head = await readHead(env, dir);
  const cur = head ? { slot: head.slot, seq: head.seq } : await best(env, dir, shard.project, tick);
  const uncommitted = committed !== undefined && cur !== null && cur !== undefined && cur.seq > committed;
  const slot: Slot = uncommitted ? cur.slot : cur?.slot === "A" ? "B" : "A";
  const seq = Math.max(cur?.seq ?? 0, committed ?? 0) + 1;
  const nonce = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  const { parts, dropped } = await encodeShardAsync(shard, { seq, nonce }, tick);
  for (let i = 0; i < parts.length; i++) {
    await env.fs.write(joinPath(dir, `${slot}-${i}.json`), parts[i]);
    await tick();
  }
  await env.fs.write(joinPath(dir, "HEAD.json"), JSON.stringify({ seq, nonce, slot, parts: parts.length }));
  return { dropped, seq };
}

export async function saveShard(env: StoreEnv, cfg: string, shard: Shard, tick: Tick = noTick): Promise<{ dropped: number }> {
  const { dropped } = await saveAt(env, dirOf(cfg, shard.project), shard, tick);
  return { dropped };
}

/** Folder of a project's index: manifest store at its top, bucket stores in sub-folders. */
export const projectDir = dirOf;

// Save counter of a project's newest manifest, from HEAD alone; 0 when there is none. Cheap change probe for readers.
export async function shardSeq(env: StoreEnv, cfg: string, project: string): Promise<number> {
  return (await readHead(env, dirOf(cfg, project)))?.seq ?? 0;
}
