import { Ledger } from "../core/ledger.ts";
import { baseName, isSubagentPath, joinPath, splitPath } from "../core/path.ts";
import { orderFiles, WINDOW_MS } from "../core/plan-scan.ts";
import type { FileJob, Listing } from "../core/plan-scan.ts";
import { trimShard } from "../core/shard.ts";
import type { Shard } from "../core/shard.ts";
import type { MetaRow, Parsed } from "../core/types.ts";
import { yieldNow } from "./clock.ts";
import { acquireLease, heartbeat, releaseLease } from "./lease.ts";
import type { LeaseEnv } from "./lease.ts";
import { idleProgress, readProgress, writeProgress } from "./progress.ts";
import type { ScanProgress } from "./progress.ts";
import { readIncrement } from "./reader.ts";
import type { ReaderEnv } from "./reader.ts";
import { createSlicer } from "./slicer.ts";
import type { Slicer } from "./slicer.ts";
import { loadShard, saveShard, shardSeq } from "./store-index.ts";
import type { StoreEnv } from "./store-index.ts";

export type { ScanProgress };

type Entry = { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean };
type Timer = { cancel(): void };

export type ScannerEnv = ReaderEnv &
  LeaseEnv &
  StoreEnv & {
    fs: { list(path: string): Promise<Entry[]> };
    clock: { after(ms: number, fn: () => void): Timer; every(ms: number, fn: () => void): Timer };
  };

export type ScanOpts = {
  sessionId: string;
  currentProject: string;
  /** Plugin config root: holds `tally/` (lease, progress, index). */
  cfg: string;
  /** Transcript roots from `scanRoots`. */
  roots: string[];
  onProgress: (p: ScanProgress) => void;
  onShardSaved: (project: string) => void;
  /** Synchronous CPU clock for the slice budget; tests inject one. */
  cpuNow?: () => number;
};

const BEAT_MS = 30_000;
const PASS_MS = 60_000;
const FOLLOW_MS = 10_000;
const UI_MS = 250;
const WRITE_MS = 2_000;
const SKIPPED = "audit.jsonl";

type ProjState = { shard: Shard; ledger: Ledger; metas: Map<string, MetaRow>; dirty: boolean };

const rootTag = (i: number) => (i === 0 ? "" : `r${i}:`);

/** Project names under the roots: first folder level; roots after the first are tagged. Roots that do not exist are skipped. */
export async function listProjects($: Pick<ScannerEnv, "fs">, roots: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (let i = 0; i < roots.length; i++) {
    try {
      for (const e of await $.fs.list(roots[i])) if (e.kind === "dir" && !e.isLink) out.add(rootTag(i) + e.name);
    } catch {
      /* root missing */
    }
  }
  return [...out];
}

// Session id from the path when no row has named one: `<id>.jsonl`, or the folder above `subagents`.
function sessionOfPath(path: string): string {
  const parts = splitPath(path);
  const at = parts.lastIndexOf("subagents");
  if (at > 0) return parts[at - 1];
  return baseName(path).replace(/\.jsonl$/, "");
}

const keyOf = (j: { size: number; mtimeMs: number }) => `${j.size}:${j.mtimeMs}`;

const emptyShard = (project: string): Shard => ({ v: 1, project, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] });

export function startScanner($: ScannerEnv, opts: ScanOpts): { stop(): void; rescan(): void } {
  const { cfg, sessionId } = opts;
  const cpu = opts.cpuNow ?? (() => Date.now());
  let stopped = false;
  let owner = false;
  let running = false;
  let again = false;
  let following = false;
  let timers: Timer[] = [];
  let progress: ScanProgress = idleProgress(false);
  let dropped = 0;
  let lastUi = -Infinity;
  let lastWrite = -Infinity;
  // A background pass that finds nothing new stays silent: no progress callback, no progress.json write.
  let quiet = false;
  const states = new Map<string, ProjState>();
  const known = new Map<string, { project: string; key: string }>();
  const seqs = new Map<string, number>();

  const clearTimers = () => {
    for (const t of timers) t.cancel();
    timers = [];
  };
  const safe = (fn: () => Promise<void>) => () => {
    void fn().catch(() => {});
  };

  async function emit(force: boolean): Promise<void> {
    if (quiet) return;
    const now = await $.clock.now();
    const snap = { ...progress, dropped };
    if (force || now - lastUi >= UI_MS) {
      lastUi = now;
      try {
        opts.onProgress(snap);
      } catch {
        /* a listener must not break the scan */
      }
    }
    if (!owner || (!force && now - lastWrite < WRITE_MS)) return;
    lastWrite = now;
    try {
      await writeProgress($, cfg, snap, now);
    } catch {
      /* progress is advisory */
    }
  }

  async function listAll(slicer: Slicer): Promise<Listing[]> {
    const out: Listing[] = [];
    for (let i = 0; i < opts.roots.length; i++) {
      const tag = rootTag(i);
      const stack: { dir: string; project: string | null }[] = [{ dir: opts.roots[i], project: null }];
      while (stack.length) {
        const { dir, project } = stack.pop()!;
        let entries: Entry[];
        try {
          entries = await $.fs.list(dir);
        } catch {
          continue;
        }
        await slicer.check();
        for (const e of entries) {
          if (e.isLink) continue;
          const path = joinPath(dir, e.name);
          if (e.kind === "dir") stack.push({ dir: path, project: project ?? tag + e.name });
          else if (e.kind === "file" && e.name.endsWith(".jsonl") && e.name !== SKIPPED) {
            out.push({ project: project ?? `${tag}_`, path, size: e.size, mtimeMs: e.mtimeMs });
          }
        }
      }
    }
    return out;
  }

  function freshState(shard: Shard): ProjState {
    const ledger = new Ledger();
    for (const r of shard.usage) ledger.offer(r, "", r.sidechain);
    const metas = new Map<string, MetaRow>();
    for (const m of shard.metas) metas.set(`${m.sessionId}\0${m.key}`, m);
    return { shard: { ...shard, usage: [], metas: [] }, ledger, metas, dirty: false };
  }

  async function stateOf(project: string): Promise<ProjState> {
    let st = states.get(project);
    if (!st) {
      st = freshState((await loadShard($, cfg, project)) ?? emptyShard(project));
      states.set(project, st);
    }
    return st;
  }

  async function agentTypeOf(path: string): Promise<string> {
    try {
      const m = JSON.parse(await $.fs.read(path.replace(/\.jsonl$/, ".meta.json"), { as: "text" })) as { agentType?: unknown };
      return typeof m.agentType === "string" && m.agentType !== "" ? m.agentType : "unknown";
    } catch {
      return "unknown";
    }
  }

  // A shrunk transcript is rare; every row of its project is dropped and the project is read again from 0.
  function resetProject(project: string): void {
    const st = freshState(emptyShard(project));
    st.dirty = true;
    states.set(project, st);
    for (const [path, k] of [...known]) if (k.project === project) known.delete(path);
    again = true;
  }

  async function readJob(job: FileJob, slicer: Slicer): Promise<void> {
    let st = await stateOf(job.project);
    let prev = st.shard.files[job.path];
    if (prev && job.size < prev.size) {
      resetProject(job.project);
      st = states.get(job.project)!;
      prev = undefined;
    }
    const isSub = isSubagentPath(job.path);
    const agentType = isSub ? (prev?.agentType ?? (await agentTypeOf(job.path))) : undefined;
    let session: string | undefined;
    const sink = (p: Parsed) => {
      session ??= p.row.sessionId;
      if (p.t === "usage") {
        const verdict = st.ledger.offer(p.row, job.path, isSub);
        if (verdict === "dup") return;
        st.dirty = true;
        // A subagent file took the request over: the kept row must read as sidechain too.
        const kept = verdict === "replace" && isSub ? st.ledger.get(p.row.requestId) : undefined;
        if (kept) kept.sidechain = true;
        return;
      }
      st.dirty = true;
      if (p.t === "user") st.shard.users.push(p.row);
      else if (p.t === "meta") st.metas.set(`${p.row.sessionId}\0${p.row.key}`, p.row);
      else st.shard.compacts.push(p.row);
    };
    // repo is not known before the first row; consumers derive it from each row's cwd.
    const ctx = { path: job.path, isSub, agentType, repo: "" };
    const next = await readIncrement($, job.path, prev, job, ctx, sink, slicer);
    const file = { ...next, isSub, sessionId: session ?? prev?.sessionId ?? sessionOfPath(job.path) };
    st.shard.files[job.path] = agentType === undefined ? file : { ...file, agentType };
    if (!prev || prev.size !== next.size || prev.mtimeMs !== next.mtimeMs) st.dirty = true;
    known.set(job.path, { project: job.project, key: keyOf(job) });
  }

  async function save(project: string): Promise<void> {
    const st = states.get(project);
    if (!st || !st.dirty) return;
    const cutoff = (await $.clock.now()) - WINDOW_MS;
    const whole = trimShard({ ...st.shard, usage: st.ledger.rows(), metas: [...st.metas.values()] }, cutoff);
    dropped += (await saveShard($, cfg, whole)).dropped;
    st.dirty = false;
    try {
      opts.onShardSaved(project);
    } catch {
      /* listener errors stay out of the scan */
    }
  }

  const live = () => !stopped && owner;

  async function pass(force: boolean): Promise<void> {
    const slicer = createSlicer(cpu, async () => {
      await emit(false);
      await yieldNow($);
    });
    const startedAt = await $.clock.now();
    const before = progress;
    quiet = !force;
    progress = { ...idleProgress(true), phase: "listing", startedAt };
    await emit(true);
    const listing = await listAll(slicer);
    const nowMs = await $.clock.now();
    const jobs = orderFiles(listing, opts.currentProject, nowMs).filter((j) => known.get(j.path)?.key !== keyOf(j));
    if (jobs.length === 0) {
      progress = { ...progress, phase: "done" };
      if (quiet) progress = before;
      await emit(true);
      return;
    }
    quiet = false;
    const last = new Map<string, number>();
    jobs.forEach((j, i) => last.set(j.project, i));
    progress = {
      ...progress,
      bytesTotal: jobs.reduce((n, j) => n + j.size, 0),
      filesTotal: jobs.length,
    };
    for (let i = 0; i < jobs.length && live(); i++) {
      const job = jobs[i];
      if (progress.phase !== job.tier) {
        progress = { ...progress, phase: job.tier };
        await emit(true);
      }
      try {
        await readJob(job, slicer);
      } catch {
        /* unreadable or vanished file: skipped this pass */
      }
      progress = { ...progress, bytesDone: progress.bytesDone + job.size, filesDone: progress.filesDone + 1 };
      if (last.get(job.project) === i) {
        try {
          await save(job.project);
        } catch {
          /* retried by the sweep below */
        }
      }
      await slicer.check();
    }
    if (!live()) return;
    for (const project of states.keys()) {
      try {
        await save(project);
      } catch {
        /* still dirty; the next pass retries */
      }
    }
    progress = { ...progress, phase: "done" };
    await emit(true);
  }

  async function runPass(force: boolean): Promise<void> {
    if (!live()) return;
    if (running) {
      again ||= force;
      return;
    }
    running = true;
    try {
      await pass(force);
    } finally {
      running = false;
      quiet = false;
    }
    if (again && live()) {
      again = false;
      await runPass(true);
    }
  }

  async function follow(): Promise<void> {
    if (stopped || owner || following) return;
    following = true;
    try {
      if (await acquireLease($, cfg, sessionId, await $.clock.now())) {
        beOwner();
        return;
      }
      progress = { ...(await readProgress($, cfg)) ?? idleProgress(false), owner: false };
      await emit(false);
      for (const project of await listProjects($, opts.roots)) {
        const seq = await shardSeq($, cfg, project);
        if (seq > 0 && seq !== seqs.get(project)) {
          seqs.set(project, seq);
          try {
            opts.onShardSaved(project);
          } catch {
            /* listener errors stay out of the scan */
          }
        }
      }
    } finally {
      following = false;
    }
  }

  function beOwner(): void {
    owner = true;
    clearTimers();
    timers.push(
      $.clock.every(BEAT_MS, safe(async () => {
        if (!owner || stopped) return;
        if (!(await heartbeat($, cfg, sessionId))) beFollower();
      })),
      $.clock.every(PASS_MS, safe(() => runPass(false))),
    );
    void runPass(true).catch(() => {});
  }

  function beFollower(): void {
    owner = false;
    clearTimers();
    timers.push($.clock.every(FOLLOW_MS, safe(follow)));
    void follow().catch(() => {});
  }

  void (async () => {
    try {
      if (await acquireLease($, cfg, sessionId, await $.clock.now())) beOwner();
      else beFollower();
    } catch {
      beFollower();
    }
  })();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimers();
      if (owner) void releaseLease($, cfg, sessionId).catch(() => {});
      owner = false;
    },
    rescan() {
      void runPass(true).catch(() => {});
    },
  };
}
