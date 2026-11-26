import type { FsReadCall } from "claude-code";
import { decodeShard, encodeShardEx, readHeader } from "../core/shard.ts";
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

async function readHead(env: StoreEnv, dir: string): Promise<Head | null> {
  try {
    const h = JSON.parse(await env.fs.read(joinPath(dir, "HEAD.json"), { as: "text" })) as Head;
    const ok = (h.slot === "A" || h.slot === "B") && Number.isInteger(h.parts) && h.parts >= 1 && typeof h.seq === "number" && typeof h.nonce === "string";
    return ok ? h : null;
  } catch {
    return null;
  }
}

// A slot is valid only when all its parts belong to one save of this project; `want` (from HEAD) also pins seq/nonce/n.
async function readSlot(env: StoreEnv, dir: string, slot: Slot, project: string, want?: Head): Promise<Found | null> {
  try {
    const p0 = await env.fs.read(joinPath(dir, `${slot}-0.json`), { as: "text" });
    const hd = readHeader(p0);
    if (!hd || hd.project !== project) return null;
    if (want && (hd.seq !== want.seq || hd.nonce !== want.nonce || hd.n !== want.parts)) return null;
    const parts = [p0];
    for (let i = 1; i < hd.n; i++) parts.push(await env.fs.read(joinPath(dir, `${slot}-${i}.json`), { as: "text" }));
    return { shard: decodeShard(parts), seq: hd.seq, slot };
  } catch {
    return null;
  }
}

// HEAD is the fast path; when it is missing, torn or its slot is inconsistent, probe both slots
// and take the valid one with the highest seq. null only when neither slot is valid.
async function best(env: StoreEnv, dir: string, project: string): Promise<Found | null> {
  const head = await readHead(env, dir);
  if (head) {
    const f = await readSlot(env, dir, head.slot, project, head);
    if (f) return f;
  }
  const a = await readSlot(env, dir, "A", project);
  const b = await readSlot(env, dir, "B", project);
  if (a && b) return a.seq >= b.seq ? a : b;
  return a ?? b;
}

export async function loadShard(env: StoreEnv, cfg: string, project: string): Promise<Shard | null> {
  return (await best(env, dirOf(cfg, project), project))?.shard ?? null;
}

// $.fs has no delete, so two slots A/B alternate: write the slot that does not hold the best save
// (all parts first, then HEAD). Parts carry {seq, nonce, i, n}, so a reader rejects a slot mixed
// from two concurrent saves; leftover extra parts are ignored because n says how many to read.
// Returns the number of rows dropped for exceeding the part limit on their own.
export async function saveShard(env: StoreEnv, cfg: string, shard: Shard): Promise<{ dropped: number }> {
  const dir = dirOf(cfg, shard.project);
  const cur = await best(env, dir, shard.project);
  const slot: Slot = cur?.slot === "A" ? "B" : "A";
  const seq = (cur?.seq ?? 0) + 1;
  const nonce = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  const { parts, dropped } = encodeShardEx(shard, { seq, nonce });
  for (let i = 0; i < parts.length; i++) await env.fs.write(joinPath(dir, `${slot}-${i}.json`), parts[i]);
  await env.fs.write(joinPath(dir, "HEAD.json"), JSON.stringify({ seq, nonce, slot, parts: parts.length }));
  return { dropped };
}
