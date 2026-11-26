import type { FsReadCall } from "claude-code";
import { joinPath } from "../core/path.ts";

export type LeaseEnv = {
  fs: { read: FsReadCall; write(path: string, text: string): Promise<void> };
  clock: { now(): Promise<number>; sleep(ms: number): Promise<void> };
};

type Lease = { sessionId: string; beatMs: number };

const STALE_MS = 90_000;
const SETTLE_MS = 300;
const pathOf = (cfg: string) => joinPath(cfg, "tally", "lease.json");

async function readLease(env: LeaseEnv, cfg: string): Promise<Lease | null> {
  try {
    const l = JSON.parse(await env.fs.read(pathOf(cfg), { as: "text" })) as Lease;
    return typeof l.sessionId === "string" && typeof l.beatMs === "number" ? l : null;
  } catch {
    return null;
  }
}

function put(env: LeaseEnv, cfg: string, l: Lease): Promise<void> {
  return env.fs.write(pathOf(cfg), JSON.stringify(l));
}

// Write-then-verify: without atomic create, the last writer wins the read-back after the settle wait.
export async function acquireLease(env: LeaseEnv, cfg: string, sessionId: string, nowMs: number): Promise<boolean> {
  const cur = await readLease(env, cfg);
  if (cur && cur.sessionId !== "" && cur.sessionId !== sessionId && nowMs - cur.beatMs <= STALE_MS) return false;
  await put(env, cfg, { sessionId, beatMs: nowMs });
  await env.clock.sleep(SETTLE_MS);
  return (await readLease(env, cfg))?.sessionId === sessionId;
}

// Call every 30 s; false means the lease was lost.
export async function heartbeat(env: LeaseEnv, cfg: string, sessionId: string): Promise<boolean> {
  const cur = await readLease(env, cfg);
  if (cur?.sessionId !== sessionId) return false;
  await put(env, cfg, { sessionId, beatMs: await env.clock.now() });
  return true;
}

// No delete in the host fs: an empty holder reads as free.
export async function releaseLease(env: LeaseEnv, cfg: string, sessionId: string): Promise<void> {
  if ((await readLease(env, cfg))?.sessionId === sessionId) await put(env, cfg, { sessionId: "", beatMs: 0 });
}
