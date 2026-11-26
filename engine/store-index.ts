import type { FsReadCall } from "claude-code";
import { decodeShard, encodeShard } from "../core/shard.ts";
import type { Shard } from "../core/shard.ts";
import { joinPath } from "../core/path.ts";

export type StoreEnv = { fs: { read: FsReadCall; write(path: string, text: string): Promise<void>; exists(path: string): Promise<boolean> } };

type Gen = "A" | "B";
type Head = { gen: Gen; parts: number };

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

async function readHead(env: StoreEnv, dir: string): Promise<Head | null> {
  try {
    const h = JSON.parse(await env.fs.read(joinPath(dir, "HEAD.json"), { as: "text" })) as Head;
    if ((h.gen !== "A" && h.gen !== "B") || !Number.isInteger(h.parts) || h.parts < 1) return null;
    return h;
  } catch {
    return null;
  }
}

// null on a missing, garbage or inconsistent store; the caller rebuilds.
export async function loadShard(env: StoreEnv, cfg: string, project: string): Promise<Shard | null> {
  const dir = dirOf(cfg, project);
  const head = await readHead(env, dir);
  if (!head) return null;
  try {
    const parts: string[] = [];
    for (let i = 0; i < head.parts; i++) parts.push(await env.fs.read(joinPath(dir, `${head.gen}-${i}.json`), { as: "text" }));
    const s = decodeShard(parts);
    return s.project === project ? s : null;
  } catch {
    return null;
  }
}

// $.fs has no delete, so two generation slots A/B alternate: always write the slot HEAD does not
// reference (all data files first, then HEAD = {gen, parts}). HEAD only ever points at a fully
// written slot; extra leftover part files in a slot are ignored because HEAD lists the part count.
export async function saveShard(env: StoreEnv, cfg: string, shard: Shard): Promise<void> {
  const dir = dirOf(cfg, shard.project);
  const cur = await readHead(env, dir);
  const gen: Gen = cur?.gen === "A" ? "B" : "A";
  const parts = encodeShard(shard);
  for (let i = 0; i < parts.length; i++) await env.fs.write(joinPath(dir, `${gen}-${i}.json`), parts[i]);
  await env.fs.write(joinPath(dir, "HEAD.json"), JSON.stringify({ gen, parts: parts.length }));
}
