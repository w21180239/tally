import type { FsReadCall } from "claude-code";
import { joinPath } from "../core/path.ts";
import { WINDOW_MS } from "../core/plan-scan.ts";
import { loadProject } from "./project-store.ts";

export type ScanProgress = {
  phase: "idle" | "listing" | "current" | "day" | "month" | "done";
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  startedAt: number;
  owner: boolean;
  /** Rows a shard save left out because one row alone exceeded a part. */
  dropped?: number;
};

export type ProgressEnv = { fs: { read: FsReadCall; write(path: string, text: string): Promise<void> } };

const pathOf = (cfg: string) => joinPath(cfg, "tally", "progress.json");

export const idleProgress = (owner = false): ScanProgress => ({
  phase: "idle",
  bytesDone: 0,
  bytesTotal: 0,
  filesDone: 0,
  filesTotal: 0,
  startedAt: 0,
  owner,
});

// Overwritten in place; the host fs has no delete or rename.
export async function writeProgress(env: ProgressEnv, cfg: string, p: ScanProgress, nowMs: number): Promise<void> {
  await env.fs.write(pathOf(cfg), JSON.stringify({ ...p, updatedAt: nowMs }));
}

export async function readProgress(env: ProgressEnv, cfg: string): Promise<(ScanProgress & { updatedAt: number }) | null> {
  try {
    const p = JSON.parse(await env.fs.read(pathOf(cfg), { as: "text" })) as ScanProgress & { updatedAt: number };
    return typeof p.phase === "string" && typeof p.filesTotal === "number" ? p : null;
  } catch {
    return null;
  }
}

/** Tokens of every priced-or-not row inside the 30-day window across the given projects. */
export async function tokens30d(env: ProgressEnv, cfg: string, projects: string[], nowMs: number): Promise<number> {
  let total = 0;
  for (const project of projects) {
    const shard = await loadProject(env, cfg, project, nowMs);
    if (!shard) continue;
    for (const r of shard.usage) {
      if (r.synthetic || r.ts < nowMs - WINDOW_MS) continue;
      const t = r.tokens;
      total += t.input + t.output + t.cacheRead + t.cw5m + t.cw1h;
    }
  }
  return total;
}

export async function debugText(env: ProgressEnv, cfg: string, projects: string[], p: ScanProgress, nowMs: number): Promise<string> {
  const tokens = await tokens30d(env, cfg, projects, nowMs);
  return `tally debug\nprogress: ${JSON.stringify(p)}\nprojects: ${projects.length}\ntokens30d: ${tokens}`;
}
