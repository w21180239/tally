import { Ledger } from "../core/ledger.ts";
import { isSubagentPath, joinPath, sessionOfPath } from "../core/path.ts";
import { orderFiles, WINDOW_MS } from "../core/plan-scan.ts";
import type { FileJob, Listing } from "../core/plan-scan.ts";
import type { Shard, ShardFile } from "../core/shard.ts";
import type { CompactRow, MetaRow, Parsed, UserRow } from "../core/types.ts";
import { yieldNow } from "./clock.ts";
import { acquireLease, heartbeat, releaseLease } from "./lease.ts";
import type { LeaseEnv } from "./lease.ts";
import { idleProgress, readProgress, writeProgress } from "./progress.ts";
import type { ScanProgress } from "./progress.ts";
import { readIncrement } from "./reader.ts";
import type { ReaderEnv } from "./reader.ts";
import { createSlicer } from "./slicer.ts";
import type { Slicer } from "./slicer.ts";
import { dayIdx, loadBuckets, saveBuckets } from "./project-store.ts";
import type { SavePlan } from "./project-store.ts";
import { shardSeq } from "./store-index.ts";
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
const SAVE_MS = 300_000;
const TEXT_KEEP = 200;
const PROMPT_PREVIEW = 120;
const SKIPPED = "audit.jsonl";

// One UTC day of a project: file states bucketed by mtime, user and compact rows by ts, meta rows by the
// mtime of the file they were last read from. Usage rows live in the ledger (cross-file dedupe) and are
// split by ts when saved.
type Day = { files: Record<string, ShardFile>; users: UserRow[]; compacts: CompactRow[]; metas: Map<string, MetaRow> };
type ProjState = {
  days: Map<number, Day>;
  ledger: Ledger;
  fileDay: Map<string, number>;
  metaDay: Map<string, number>;
  /** Day buckets with changes not yet saved. */
  dirty: Set<number>;
  /** Bucket seqs the last committed manifest holds. */
  seqs: Record<string, number>;
};

const anyDirty = (st: ProjState) => st.dirty.size > 0;
const emptyState = (): ProjState => ({ days: new Map(), ledger: new Ledger(), fileDay: new Map(), metaDay: new Map(), dirty: new Set(), seqs: {} });

function dayOf(st: ProjState, idx: number): Day {
  let d = st.days.get(idx);
  if (!d) {
    d = { files: {}, users: [], compacts: [], metas: new Map() };
    st.days.set(idx, d);
  }
  return d;
}

function fileOf(st: ProjState, path: string): ShardFile | undefined {
  const i = st.fileDay.get(path);
  return i === undefined ? undefined : st.days.get(i)?.files[path];
}

function putMeta(st: ProjState, key: string, row: MetaRow, idx: number): void {
  const old = st.metaDay.get(key);
  const cur = old === undefined ? undefined : st.days.get(old)?.metas.get(key);
  if (old === idx && JSON.stringify(cur?.value) === JSON.stringify(row.value)) return;
  if (old !== undefined && old !== idx) {
    st.days.get(old)?.metas.delete(key);
    st.dirty.add(old);
  }
  dayOf(st, idx).metas.set(key, row);
  st.metaDay.set(key, idx);
  st.dirty.add(idx);
}

function putFile(st: ProjState, path: string, f: ShardFile): void {
  const old = st.fileDay.get(path);
  const idx = dayIdx(f.mtimeMs);
  if (old !== undefined && old !== idx) {
    delete st.days.get(old)?.files[path];
    st.dirty.add(old);
  }
  dayOf(st, idx).files[path] = f;
  st.fileDay.set(path, idx);
  st.dirty.add(idx);
}

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

const keyOf = (j: { size: number; mtimeMs: number }) => `${j.size}:${j.mtimeMs}`;

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
  // Outlives the in-memory state, which is dropped once a project is clean.
  const lastSave = new Map<string, number>();

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

  async function stateOf(project: string, slicer: Slicer): Promise<ProjState> {
    const have = states.get(project);
    if (have) return have;
    const st = emptyState();
    const l = await loadBuckets($, cfg, project, await $.clock.now(), () => slicer.check());
    if (l.kind === "ok") {
      for (const [idx, b] of l.days) {
        const d = dayOf(st, idx);
        Object.assign(d.files, b.files);
        for (const path of Object.keys(b.files)) st.fileDay.set(path, idx);
        for (const r of b.usage) st.ledger.offer(r, "", r.sidechain);
        d.users = b.users;
        d.compacts = b.compacts;
        for (const m of b.metas) {
          const key = `${m.sessionId}\0${m.key}`;
          d.metas.set(key, m);
          st.metaDay.set(key, idx);
        }
      }
      st.seqs = l.seqs;
    } else if ([...known.values()].some((k) => k.project === project)) {
      // The index is gone or damaged under files already marked read: read the project again.
      forget(project);
    }
    states.set(project, st);
    return st;
  }

  function forget(project: string): void {
    for (const [path, k] of [...known]) if (k.project === project) known.delete(path);
    again = true;
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
  function resetProject(project: string): ProjState {
    const st = emptyState();
    states.set(project, st);
    forget(project);
    return st;
  }

  async function readJob(job: FileJob, slicer: Slicer): Promise<void> {
    let st = await stateOf(job.project, slicer);
    let prev = fileOf(st, job.path);
    if (prev && job.size < prev.size) {
      st = resetProject(job.project);
      prev = undefined;
    }
    const isSub = isSubagentPath(job.path);
    const agentType = isSub ? (prev?.agentType ?? (await agentTypeOf(job.path))) : undefined;
    let session: string | undefined;
    const sink = (p: Parsed, at?: number) => {
      session ??= p.row.sessionId;
      if (p.t === "usage") {
        const old = st.ledger.get(p.row.requestId);
        const verdict = st.ledger.offer(p.row, job.path, isSub);
        if (verdict === "dup") return;
        st.dirty.add(dayIdx(p.row.ts));
        if (old) st.dirty.add(dayIdx(old.ts));
        // A subagent file took the request over: the kept row must read as sidechain too.
        const kept = verdict === "replace" && isSub ? st.ledger.get(p.row.requestId) : undefined;
        if (kept) kept.sidechain = true;
      } else if (p.t === "user") {
        // The index keeps a prompt's first TEXT_KEEP chars and where its line starts; the rest is fetched on demand.
        const row = p.row;
        if (row.text !== undefined) row.text = row.text.slice(0, TEXT_KEEP);
        if (row.kind === "prompt" && at !== undefined) {
          row.fileKey = job.path;
          row.offset = at;
        }
        const idx = dayIdx(row.ts);
        dayOf(st, idx).users.push(row);
        st.dirty.add(idx);
      } else if (p.t === "meta") {
        // last-prompt is a label; the index keeps a preview.
        if (p.row.key === "last-prompt" && typeof p.row.value === "string") p.row.value = p.row.value.slice(0, PROMPT_PREVIEW);
        putMeta(st, `${p.row.sessionId}\0${p.row.key}`, p.row, dayIdx(job.mtimeMs));
      } else {
        const idx = dayIdx(p.row.ts);
        dayOf(st, idx).compacts.push(p.row);
        st.dirty.add(idx);
      }
    };
    // repo is not known before the first row; consumers derive it from each row's cwd.
    const ctx = { path: job.path, isSub, agentType, repo: "" };
    const next = await readIncrement($, job.path, prev, job, ctx, sink, slicer);
    const file: ShardFile = { ...next, isSub, sessionId: session ?? prev?.sessionId ?? sessionOfPath(job.path) };
    if (agentType !== undefined) file.agentType = agentType;
    putFile(st, job.path, file);
    known.set(job.path, { project: job.project, key: keyOf(job) });
  }

  // Writes the project's dirty buckets, then its manifest. Steady-state saves are spaced SAVE_MS apart per
  // project; the first save of a project (cold scan) goes straight out.
  async function save(project: string, slicer: Slicer): Promise<void> {
    const st = states.get(project);
    if (!st || !anyDirty(st)) return;
    const nowMs = await $.clock.now();
    const prev = lastSave.get(project);
    if (prev !== undefined && nowMs - prev < SAVE_MS) return;
    const tick = () => slicer.check();
    const cutoff = nowMs - WINDOW_MS;
    const cutIdx = dayIdx(cutoff);
    for (const idx of [...st.days.keys()]) {
      if (idx >= cutIdx) continue;
      const gone = st.days.get(idx)!;
      for (const path of Object.keys(gone.files)) st.fileDay.delete(path);
      for (const key of gone.metas.keys()) st.metaDay.delete(key);
      st.days.delete(idx);
    }
    for (const idx of [...st.dirty]) if (idx < cutIdx) st.dirty.delete(idx);
    // One pass over the ledger buckets the usage rows of the dirty days.
    const usage = new Map<number, Shard["usage"]>();
    const rows = st.ledger.rows();
    for (let i = 0; i < rows.length; i++) {
      const idx = dayIdx(rows[i].ts);
      if (st.dirty.has(idx) && rows[i].ts >= cutoff) {
        const l = usage.get(idx);
        if (l) l.push(rows[i]);
        else usage.set(idx, [rows[i]]);
      }
      if ((i & 4095) === 4095) await tick();
    }
    const plan: SavePlan = { days: new Map() };
    for (const idx of st.dirty) {
      const d = st.days.get(idx);
      const files: Record<string, ShardFile> = {};
      for (const [path, f] of Object.entries(d?.files ?? {})) if (f.mtimeMs >= cutoff) files[path] = f;
      plan.days.set(idx, {
        v: 1,
        project,
        files,
        usage: usage.get(idx) ?? [],
        users: (d?.users ?? []).filter((r) => r.ts >= cutoff),
        metas: d ? [...d.metas.values()] : [],
        compacts: (d?.compacts ?? []).filter((r) => r.ts >= cutoff),
        snapshots: [],
      });
    }
    const r = await saveBuckets($, cfg, project, plan, st.seqs, nowMs, tick);
    st.seqs = r.seqs;
    dropped += r.dropped;
    st.dirty.clear();
    lastSave.set(project, nowMs);
    try {
      opts.onShardSaved(project);
    } catch {
      /* listener errors stay out of the scan */
    }
  }

  const live = () => !stopped && owner;

  // A clean project other than the current one is dropped from memory; a changed file loads it again.
  async function saveAndRelease(project: string, slicer: Slicer): Promise<void> {
    try {
      await save(project, slicer);
    } catch {
      /* still dirty; the next sweep retries */
    }
    const st = states.get(project);
    if (st && !anyDirty(st) && project !== opts.currentProject) states.delete(project);
  }

  async function sweep(slicer: Slicer): Promise<void> {
    for (const project of [...states.keys()]) await saveAndRelease(project, slicer);
  }

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
      await sweep(slicer);
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
        await saveAndRelease(job.project, slicer);
      }
      await slicer.check();
    }
    if (!live()) return;
    await sweep(slicer);
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
