import { describe, expect, test } from "claude-code/testing";
import { orderFiles, projectNameOf, DAY_MS } from "../core/plan-scan.ts";
import { debugText, readProgress } from "../engine/progress.ts";
import type { ScanProgress } from "../engine/progress.ts";
import { listProjects, startScanner } from "../engine/scanner.ts";
import type { ScanOpts } from "../engine/scanner.ts";
import { loadShard } from "../engine/store-index.ts";
import { assistant } from "./fixtures/lines.ts";
import { worldOf } from "./world.ts";
import type { World } from "./world.ts";

const CFG = "/cfg";
const ROOT = "/cfg/projects";
const LEASE = "/cfg/tally/lease.json";
const HOUR = 3_600_000;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// Alternates real macrotasks (async chains settle) with manual clock steps (sleeps and timers fire).
async function pump(w: World, until: () => boolean, step = 10, limit = 20_000) {
  for (let i = 0; i < limit; i++) {
    await tick();
    if (until()) return;
    await w.advance(step);
  }
  throw new Error("pump: condition not reached");
}

const row = (id: string, sid = "s1") => assistant({ requestId: id, extra: { sessionId: sid } });
const file = (w: World, project: string, name: string, ids: string[], age: number) => {
  const p = `${ROOT}/${project}/${name}`;
  w.put(p, ids.map((i) => row(i)).join("\n") + "\n");
  w.setMtime(p, w.time() - age);
  return p;
};

// 3 projects, 40 transcripts: current project 10 (within 24 h), alpha 15 (8 in 24 h, 7 older), beta 15 (5 in 24 h, 10 older).
function seed(w: World): string[] {
  const all: string[] = [];
  for (let i = 0; i < 10; i++) all.push(file(w, "-cur", `c${i}.jsonl`, [`cur-${i}-a`, `cur-${i}-b`], (i + 1) * 60_000));
  for (let i = 0; i < 15; i++) all.push(file(w, "-alpha", `a${i}.jsonl`, [`alpha-${i}-a`, `alpha-${i}-b`], i < 8 ? (i + 1) * HOUR : 3 * DAY_MS + i * HOUR));
  for (let i = 0; i < 15; i++) all.push(file(w, "-beta", `b${i}.jsonl`, [`beta-${i}-a`, `beta-${i}-b`], i < 5 ? (i + 1) * HOUR : 5 * DAY_MS + i * HOUR));
  return all;
}

function boot(w: World, sessionId: string, extra: Partial<ScanOpts> = {}) {
  const v = w.view();
  const phases: string[] = [];
  const seen: ScanProgress[] = [];
  const saved: string[] = [];
  const s = startScanner(v.$, {
    sessionId,
    currentProject: "-cur",
    cfg: CFG,
    roots: [ROOT],
    onProgress: (p) => {
      seen.push(p);
      if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
    },
    onShardSaved: (project) => saved.push(project),
    ...extra,
  });
  const last = () => seen[seen.length - 1];
  const done = () => last()?.phase === "done";
  return { v, s, phases, seen, saved, last, done };
}

const transcriptReads = (reads: { path: string }[]) => reads.filter((r) => r.path.startsWith(ROOT));

describe("orderFiles", () => {
  const now = 100 * DAY_MS;
  const f = (project: string, path: string, age: number) => ({ project, path, size: 1, mtimeMs: now - age });

  test("current project first, then 24 h, then 30 d; older than 30 d dropped; newest first inside a tier", () => {
    const jobs = orderFiles(
      [
        f("x", "x-old", 40 * DAY_MS),
        f("y", "y-month-new", 2 * DAY_MS),
        f("cur", "cur-old", 20 * DAY_MS),
        f("y", "y-day-old", 20 * HOUR),
        f("y", "y-month-old", 25 * DAY_MS),
        f("cur", "cur-new", HOUR),
        f("x", "x-day-new", HOUR),
        f("cur", "cur-ancient", 31 * DAY_MS),
      ],
      "cur",
      now,
    );
    expect(jobs.map((j) => `${j.tier}:${j.path}`)).toEqual([
      "current:cur-new",
      "current:cur-old",
      "day:x-day-new",
      "day:y-day-old",
      "month:y-month-new",
      "month:y-month-old",
    ]);
  });

  test("project folder name follows the cwd", () => {
    expect(projectNameOf("/work/demo-app")).toBe("-work-demo-app");
    expect(projectNameOf("C:\\Users\\a b")).toBe("C--Users-a-b");
  });
});

describe("scanner", () => {
  test("current project finishes first; phases run listing, current, day, month, done", async () => {
    const w = worldOf();
    seed(w);
    const a = boot(w, "a");
    await pump(w, a.done);
    expect(a.phases).toEqual(["idle", "listing", "current", "day", "month", "done"].slice(1));
    expect(a.saved[0]).toBe("-cur");
    expect([...a.saved].sort()).toEqual(["-alpha", "-beta", "-cur"]);
    const p = a.last();
    expect(p.filesTotal).toBe(40);
    expect(p.filesDone).toBe(40);
    expect(p.bytesDone).toBe(p.bytesTotal);
    expect(p.owner).toBe(true);
    // per-project shard holds every row
    expect((await loadShard(w.$, CFG, "-cur"))!.usage.length).toBe(20);
    expect((await loadShard(w.$, CFG, "-alpha"))!.usage.length).toBe(30);
    expect((await loadShard(w.$, CFG, "-beta"))!.usage.length).toBe(30);
    // the first file read belongs to the current project and the newest one
    expect(transcriptReads(a.v.reads)[0].path).toBe(`${ROOT}/-cur/c0.jsonl`);
    a.s.stop();
  });

  test("owner writes progress.json (small, valid); files outside the window, audit.jsonl and non-jsonl are not read", async () => {
    const w = worldOf();
    file(w, "-cur", "in.jsonl", ["r1"], HOUR);
    file(w, "-cur", "ancient.jsonl", ["r2"], 31 * DAY_MS);
    w.put(`${ROOT}/-cur/audit.jsonl`, row("r3") + "\n");
    w.put(`${ROOT}/-cur/notes.txt`, "x");
    const a = boot(w, "a");
    await pump(w, a.done);
    const pf = await readProgress(w.$, CFG);
    expect(pf?.phase).toBe("done");
    expect(pf?.filesTotal).toBe(1);
    expect(w.size("/cfg/tally/progress.json")!).toBeLessThan(4 * 1024 * 1024);
    expect(transcriptReads(a.v.reads).map((r) => r.path)).toEqual([`${ROOT}/-cur/in.jsonl`]);
    a.s.stop();
  });

  test("each slice stays inside the CPU budget", async () => {
    const w = worldOf();
    seed(w);
    let t = 0;
    const base = w.view();
    const yields: number[] = [];
    const $ = {
      ...base.$,
      clock: {
        ...base.$.clock,
        sleep: (ms: number) => {
          if (ms === 0) yields.push(t);
          return base.$.clock.sleep(ms);
        },
      },
    };
    const phases: string[] = [];
    const s = startScanner($, {
      sessionId: "a",
      currentProject: "-cur",
      cfg: CFG,
      roots: [ROOT],
      cpuNow: () => (t += 7),
      onProgress: (p) => phases.push(p.phase),
      onShardSaved: () => {},
    });
    await pump(w, () => phases[phases.length - 1] === "done");
    expect(yields.length).toBeGreaterThan(10);
    let worst = 0;
    for (let i = 1; i < yields.length; i++) worst = Math.max(worst, yields[i] - yields[i - 1]);
    // a yield fires on the first check past 50 ms; one check costs 7 ms here, and the yield itself reads the clock once
    expect(worst).toBeLessThanOrEqual(50 + 2 * 7);
    s.stop();
  });

  test("a second scan reads no unchanged transcript; a changed file reads only itself", async () => {
    const w = worldOf();
    const all = seed(w);
    const a = boot(w, "a");
    await pump(w, a.done);
    const n = a.seen.length;
    const before = transcriptReads(a.v.reads).length;
    a.s.rescan();
    await pump(w, () => a.seen.length > n && a.done());
    expect(transcriptReads(a.v.reads).length).toBe(before);

    w.append(all[3], row("cur-3-new") + "\n");
    const m = a.seen.length;
    a.s.rescan();
    await pump(w, () => a.seen.length > m && a.done());
    const fresh = transcriptReads(a.v.reads).slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    expect([...new Set(fresh.map((r) => r.path))]).toEqual([all[3]]);
    expect((await loadShard(w.$, CFG, "-cur"))!.usage.length).toBe(21);
    a.s.stop();
  });

  test("a new session after a finished scan reads no transcript either", async () => {
    const w = worldOf();
    seed(w);
    const a = boot(w, "a");
    await pump(w, a.done);
    a.s.stop();
    await pump(w, () => (w.text(LEASE) ?? "").includes('"sessionId":""'));
    const b = boot(w, "b");
    await pump(w, b.done);
    expect(b.last().owner).toBe(true);
    expect(transcriptReads(b.v.reads)).toEqual([]);
    b.s.stop();
  });

  test("a non-owner writes nothing and reports owner:false from the progress file and shard heads", async () => {
    const w = worldOf();
    seed(w);
    const a = boot(w, "a");
    await pump(w, a.done);
    const b = boot(w, "b");
    await pump(w, () => b.saved.length === 3 && b.last()?.phase === "done");
    expect(b.v.writes.length).toBe(0);
    expect(transcriptReads(b.v.reads)).toEqual([]);
    expect(b.last().owner).toBe(false);
    expect(b.last().filesTotal).toBe(40);
    expect(a.last().owner).toBe(true);
    // and keeps writing nothing while it keeps polling
    await w.advance(35_000);
    await tick();
    expect(b.v.writes.length).toBe(0);
    a.s.stop();
    b.s.stop();
  });

  test("a follower takes over once the holder's heartbeat is stale", async () => {
    const w = worldOf();
    seed(w);
    w.put(LEASE, JSON.stringify({ sessionId: "ghost", beatMs: w.time() }));
    const b = boot(w, "b");
    await pump(w, () => b.last()?.phase === "idle" || b.seen.length > 0);
    expect(b.last().owner).toBe(false);
    expect(b.v.writes.length).toBe(0);
    await pump(w, b.done, 1000);
    expect(b.last().owner).toBe(true);
    expect(JSON.parse(w.text(LEASE)!).sessionId).toBe("b");
    expect([...b.saved].sort()).toEqual(["-alpha", "-beta", "-cur"]);
    b.s.stop();
  });

  test("an owner that loses the lease stops writing", async () => {
    const w = worldOf();
    seed(w);
    const a = boot(w, "a");
    await pump(w, a.done);
    w.put(LEASE, JSON.stringify({ sessionId: "z", beatMs: w.time() }));
    const writes = a.v.writes.length;
    await pump(w, () => a.last().owner === false, 1000);
    // heartbeat saw the new holder and wrote nothing; later passes stay quiet
    await w.advance(120_000);
    await tick();
    expect(a.v.writes.length).toBe(writes);
    expect(JSON.parse(w.text(LEASE)!).sessionId).toBe("z");
    a.s.stop();
  });

  test("heartbeat refreshes the lease and a 60 s pass picks up appended data", async () => {
    const w = worldOf();
    const all = seed(w);
    const a = boot(w, "a");
    await pump(w, a.done);
    const beat0 = JSON.parse(w.text(LEASE)!).beatMs;
    w.append(all[0], row("late") + "\n");
    const saves = a.saved.length;
    await pump(w, () => a.saved.length > saves, 1000, 20_000);
    expect(JSON.parse(w.text(LEASE)!).beatMs).toBeGreaterThan(beat0);
    expect((await loadShard(w.$, CFG, "-cur"))!.usage.length).toBe(21);
    a.s.stop();
  });

  test("a background pass that finds nothing new emits no progress and writes no progress or index file", async () => {
    const w = worldOf();
    seed(w);
    const a = boot(w, "a");
    await pump(w, a.done);
    const seen = a.seen.length;
    const writes = a.v.writes.length;
    for (let i = 0; i < 13; i++) {
      await w.advance(10_000);
      await tick();
      await tick();
    }
    expect(a.seen.length).toBe(seen);
    const extra = a.v.writes.slice(writes).map((x) => x.path);
    expect(extra.length).toBeGreaterThan(0);
    expect(extra.every((p) => p === LEASE)).toBe(true);
    a.s.stop();
  });

  test("a shrunk transcript drops the project's old rows before re-adding", async () => {
    const w = worldOf();
    const p = file(w, "-cur", "s.jsonl", ["old-1", "old-2", "old-3"], HOUR);
    file(w, "-cur", "other.jsonl", ["keep-1"], 2 * HOUR);
    const a = boot(w, "a");
    await pump(w, a.done);
    expect((await loadShard(w.$, CFG, "-cur"))!.usage.length).toBe(4);
    w.put(p, row("new-1") + "\n");
    w.setMtime(p, w.time() - 1000);
    const n = a.seen.length;
    a.s.rescan();
    await pump(w, () => a.seen.length > n + 1 && a.done() && a.saved.length >= 2);
    const ids = (await loadShard(w.$, CFG, "-cur"))!.usage.map((r) => r.requestId).sort();
    expect(ids).toEqual(["keep-1", "new-1"]);
    a.s.stop();
  });

  test("requestId dedupes across files; the subagent file owns it and its type comes from the meta file", async () => {
    const w = worldOf();
    file(w, "-cur", "main.jsonl", ["dup-1", "solo"], HOUR);
    const sub = `${ROOT}/-cur/main/subagents/agent-a1.jsonl`;
    w.put(sub, row("dup-1", "s1") + "\n");
    w.setMtime(sub, w.time() - HOUR);
    w.put(`${ROOT}/-cur/main/subagents/agent-a1.meta.json`, JSON.stringify({ agentType: "Explore" }));
    const orphan = `${ROOT}/-cur/main/subagents/agent-a2.jsonl`;
    w.put(orphan, row("orphan") + "\n");
    w.setMtime(orphan, w.time() - HOUR);
    const a = boot(w, "a");
    await pump(w, a.done);
    const shard = (await loadShard(w.$, CFG, "-cur"))!;
    expect(shard.usage.map((r) => r.requestId).sort()).toEqual(["dup-1", "orphan", "solo"]);
    expect(shard.usage.find((r) => r.requestId === "dup-1")!.sidechain).toBe(true);
    expect(shard.files[sub]).toMatchObject({ isSub: true, agentType: "Explore", sessionId: "s1" });
    expect(shard.files[orphan].agentType).toBe("unknown");
    expect(Object.keys(shard.files).some((k) => k.endsWith(".meta.json"))).toBe(false);
    a.s.stop();
  });

  test("a second root is scanned and its projects are tagged", async () => {
    const w = worldOf();
    const app = "/app/sessions";
    w.put(`${app}/org1/local_1/x.jsonl`, row("app-1") + "\n");
    w.setMtime(`${app}/org1/local_1/x.jsonl`, w.time() - HOUR);
    file(w, "-cur", "m.jsonl", ["m1"], HOUR);
    expect((await listProjects(w.$, [ROOT, app, "/missing"])).sort()).toEqual(["-cur", "r1:org1"]);
    const a = boot(w, "a", { roots: [ROOT, app] });
    await pump(w, a.done);
    expect((await loadShard(w.$, CFG, "r1:org1"))!.usage.length).toBe(1);
    a.s.stop();
  });

  test("debug text carries the progress JSON and 30-day tokens", async () => {
    const w = worldOf();
    seed(w);
    const a = boot(w, "a");
    await pump(w, a.done);
    const projects = await listProjects(w.$, [ROOT]);
    const text = await debugText(w.$, CFG, projects, a.last(), w.time());
    expect(text).toContain('"phase":"done"');
    expect(text).toContain("projects: 3");
    expect(text).toContain("tokens30d: 8000"); // 80 rows x 100 tokens
    a.s.stop();
  });
});
