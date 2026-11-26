import { describe, expect, test } from "claude-code/testing";
import { orderFiles, projectNameOf, DAY_MS } from "../core/plan-scan.ts";
import { debugText, readProgress } from "../engine/progress.ts";
import type { ScanProgress } from "../engine/progress.ts";
import { listProjects, startScanner } from "../engine/scanner.ts";
import type { ScanOpts } from "../engine/scanner.ts";
import { loadProject } from "../engine/project-store.ts";
import { utf8Length } from "../core/lines.ts";
import { dayIdx, dayKey, loadBuckets } from "../engine/project-store.ts";
import { projectDir } from "../engine/store-index.ts";
import { assistant, compactBoundary, meta, user } from "./fixtures/lines.ts";
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

type Gate = (path: string, offset: number) => Promise<void> | undefined;

// `gate` runs before every read of this session: return a promise to hold the read (a rejection fails it).
function boot(w: World, sessionId: string, extra: Partial<ScanOpts> = {}, gate?: Gate) {
  const v = w.view();
  let env = v.$;
  if (gate) {
    const inner = v.$.fs.read as (p: string, o?: unknown) => Promise<unknown>;
    const read = ((p: string, o: { offset?: number } = {}) => {
      const g = gate(p, o.offset ?? 0);
      return g ? g.then(() => inner(p, o)) : inner(p, o);
    }) as typeof v.$.fs.read;
    env = { ...v.$, fs: { ...v.$.fs, read } };
  }
  const phases: string[] = [];
  const seen: ScanProgress[] = [];
  const saved: string[] = [];
  const s = startScanner(env, {
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

const shardOf = (w: World, project: string) => loadProject(w.$, CFG, project, w.time());
// Steady-state saves wait 5 min per project: move past that and run a pass so the sweep writes.
async function flush(w: World, a: { s: { rescan(): void }; seen: ScanProgress[]; done(): boolean }) {
  await w.advance(300_000);
  const n = a.seen.length;
  a.s.rescan();
  await pump(w, () => a.seen.length > n && a.done());
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
    expect((await shardOf(w, "-cur"))!.usage.length).toBe(20);
    expect((await shardOf(w, "-alpha"))!.usage.length).toBe(30);
    expect((await shardOf(w, "-beta"))!.usage.length).toBe(30);
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
    await flush(w, a);
    expect((await shardOf(w, "-cur"))!.usage.length).toBe(21);
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
    await pump(w, () => a.saved.length > saves, 1000, 2000);
    expect(JSON.parse(w.text(LEASE)!).beatMs).toBeGreaterThan(beat0);
    expect((await shardOf(w, "-cur"))!.usage.length).toBe(21);
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
    expect((await shardOf(w, "-cur"))!.usage.length).toBe(4);
    w.put(p, row("new-1") + "\n");
    w.setMtime(p, w.time() - 1000);
    const n = a.seen.length;
    a.s.rescan();
    await pump(w, () => a.seen.length > n + 1 && a.done());
    await flush(w, a);
    const ids = (await shardOf(w, "-cur"))!.usage.map((r) => r.requestId).sort();
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
    const shard = (await shardOf(w, "-cur"))!;
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
    expect((await shardOf(w, "r1:org1"))!.usage.length).toBe(1);
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
    let ticks = 0;
    await debugText(w.$, CFG, projects, a.last(), w.time(), async () => void ticks++);
    expect(ticks).toBeGreaterThan(0);
    a.s.stop();
  });
});

describe("scanner index", () => {
  const HOURS = 3_600_000;
  const noon = (w: World, k: number) => (dayIdx(w.time()) - k) * DAY_MS + 12 * HOURS;
  const dated = (id: string, ts: number) => assistant({ requestId: id, extra: { sessionId: "s1", timestamp: new Date(ts).toISOString() } });
  const dayFile = (w: World, name: string, k: number, ids: string[]) => {
    const p = `${ROOT}/-cur/${name}`;
    w.put(p, ids.map((i) => dated(i, noon(w, k))).join("\n") + "\n");
    w.setMtime(p, noon(w, k));
    return p;
  };

  test("a file growing today rewrites only today's bucket and the manifest", async () => {
    const w = worldOf();
    await w.advance(100 * DAY_MS);
    dayFile(w, "d3.jsonl", 3, ["x3a", "x3b"]);
    dayFile(w, "d2.jsonl", 2, ["x2a"]);
    const today = dayFile(w, "d0.jsonl", 0, ["x0a"]);
    const a = boot(w, "a");
    await pump(w, a.done);
    const keys = [3, 2, 0].map((k) => dayKey(dayIdx(noon(w, k))));
    const dir = projectDir(CFG, "-cur");
    for (const k of keys) expect(w.text(`${dir}/d-${k}/HEAD.json`)).toBeDefined();
    const before = a.v.writes.length;
    w.append(today, dated("x0b", noon(w, 0)) + "\n");
    w.setMtime(today, noon(w, 0) + 1000);
    await flush(w, a);
    const paths = a.v.writes.slice(before).map((x) => x.path).filter((x) => x.startsWith(dir));
    const buckets = new Set(paths.map((x) => x.slice(dir.length + 1).split("/")[0]).filter((x) => x.startsWith("d-")));
    expect([...buckets]).toEqual([`d-${keys[2]}`]);
    expect(paths.some((x) => x.slice(dir.length + 1).indexOf("/") < 0)).toBe(true); // manifest
    const all = await shardOf(w, "-cur");
    expect(all!.usage.map((r) => r.requestId).sort()).toEqual(["x0a", "x0b", "x2a", "x3a", "x3b"]);
    a.s.stop();
  });

  test("steady-state saves of a project are spaced 5 min apart; the first save is immediate", async () => {
    const w = worldOf();
    await w.advance(100 * DAY_MS);
    const p = dayFile(w, "d0.jsonl", 0, ["r1"]);
    const a = boot(w, "a");
    await pump(w, a.done);
    const indexWrites = () => a.v.writes.filter((x) => x.path.includes("/tally/index/")).length;
    const first = indexWrites();
    expect(first).toBeGreaterThan(0);
    w.append(p, dated("r2", noon(w, 0)) + "\n");
    w.setMtime(p, noon(w, 0) + 5000);
    for (let i = 0; i < 20; i++) {
      await w.advance(10_000);
      await tick();
      await tick();
    }
    expect(indexWrites()).toBe(first);
    for (let i = 0; i < 12; i++) {
      await w.advance(10_000);
      await tick();
      await tick();
    }
    expect(indexWrites()).toBeGreaterThan(first);
    expect((await shardOf(w, "-cur"))!.usage.length).toBe(2);
    a.s.stop();
  });

  test("the 5 min spacing also holds for a project that was dropped from memory and reloaded", async () => {
    const w = worldOf();
    await w.advance(100 * DAY_MS);
    const p = `${ROOT}/-alpha/a.jsonl`;
    w.put(p, dated("r1", noon(w, 0)) + "\n");
    w.setMtime(p, noon(w, 0));
    file(w, "-cur", "c.jsonl", ["c1"], HOURS);
    const a = boot(w, "a");
    await pump(w, a.done);
    const indexWrites = () => a.v.writes.filter((x) => x.path.includes("/tally/index/")).length;
    const first = indexWrites();
    w.append(p, dated("r2", noon(w, 0)) + "\n");
    w.setMtime(p, noon(w, 0) + 5000);
    for (let i = 0; i < 20; i++) {
      await w.advance(10_000);
      await tick();
      await tick();
    }
    expect(indexWrites()).toBe(first);
    for (let i = 0; i < 12; i++) {
      await w.advance(10_000);
      await tick();
      await tick();
    }
    expect(indexWrites()).toBeGreaterThan(first);
    expect((await shardOf(w, "-alpha"))!.usage.length).toBe(2);
    a.s.stop();
  });

  test("meta rows keep only the latest value per session and key", async () => {
    const w = worldOf();
    const p = `${ROOT}/-cur/m.jsonl`;
    w.put(p, [meta("ai-title", { aiTitle: "first" }), meta("ai-title", { aiTitle: "second" }), meta("custom-title", { customTitle: "c" }), meta("last-prompt", { lastPrompt: "p".repeat(500) }), row("m1")].join("\n") + "\n");
    w.setMtime(p, w.time() - HOURS);
    const a = boot(w, "a");
    await pump(w, a.done);
    const metas = (await shardOf(w, "-cur"))!.metas;
    expect(metas.map((m) => `${m.key}=${m.value}`).sort()).toEqual(["ai-title=second", "custom-title=c", `last-prompt=${"p".repeat(120)}`]);
    a.s.stop();
  });

  test("a prompt keeps 200 chars and a pointer to its line; notices keep no text", async () => {
    const w = worldOf();
    const p = `${ROOT}/-cur/u.jsonl`;
    const lead = assistant({ requestId: "lead", content: [{ type: "text", text: "caf\u00e9 \u4e2d\u6587" }], extra: { sessionId: "s1" } }) + "\n";
    const long = "q".repeat(500);
    w.put(p, lead + user(long, { sessionId: "s1" }) + "\n" + user("<system-reminder>x</system-reminder>", { sessionId: "s1" }) + "\n");
    w.setMtime(p, w.time() - HOURS);
    const a = boot(w, "a");
    await pump(w, a.done);
    const users = (await shardOf(w, "-cur"))!.users;
    const prompt = users.find((u) => u.kind === "prompt")!;
    expect(prompt.text).toBe("q".repeat(200));
    expect(prompt.chars).toBe(500);
    expect(prompt.fileKey).toBe(p);
    expect(prompt.offset).toBe(utf8Length(lead));
    expect(await w.$.fs.read(p, { offset: prompt.offset!, length: 14 })).toBe('{"type":"user"');
    const notice = users.find((u) => u.kind === "notice")!;
    expect(notice.text).toBeUndefined();
    expect(notice.offset).toBeUndefined();
    a.s.stop();
  });

  test("a damaged bucket makes the project read again from its transcripts", async () => {
    const w = worldOf();
    seed(w);
    const a = boot(w, "a");
    await pump(w, a.done);
    a.s.stop();
    await pump(w, () => (w.text(LEASE) ?? "").includes('"sessionId":""'));
    const dir = projectDir(CFG, "-cur");
    for (const f of (await w.$.fs.list(dir)).filter((e) => e.kind === "dir")) {
      w.put(`${dir}/${f.name}/A-0.json`, "garbage");
      w.put(`${dir}/${f.name}/B-0.json`, "garbage");
    }
    const b = boot(w, "b");
    await pump(w, b.done);
    expect(transcriptReads(b.v.reads).filter((r) => r.path.includes("/-cur/")).length).toBeGreaterThan(0);
    await flush(w, b);
    expect((await shardOf(w, "-cur"))!.usage.length).toBe(20);
    b.s.stop();
  });
  test("a warm start with unchanged transcripts writes no index file and reads no transcript", async () => {
    const w = worldOf();
    await w.advance(100 * DAY_MS);
    for (let k = 0; k < 5; k++) for (let n = 0; n < 3; n++) dayFile(w, `d${k}-${n}.jsonl`, k, [`w${k}${n}`]);
    const a = boot(w, "a");
    await pump(w, a.done);
    a.s.stop();
    await pump(w, () => (w.text(LEASE) ?? "").includes('"sessionId":""'));
    const b = boot(w, "b");
    await pump(w, b.done);
    for (let i = 0; i < 40; i++) {
      await w.advance(10_000);
      await tick();
      await tick();
    }
    expect(b.v.writes.filter((x) => x.path.includes("/tally/index/")).length).toBe(0);
    expect(transcriptReads(b.v.reads).length).toBe(0);
    expect((await shardOf(w, "-cur"))!.usage.length).toBe(15);
    b.s.stop();
  });

  const indexWritesOf = (v: { writes: { path: string }[] }) => v.writes.filter((x) => x.path.includes("/tally/index/"));

  test("an owner that lost the lease mid-pass does not save when its read returns", async () => {
    const w = worldOf();
    await w.advance(100 * DAY_MS);
    dayFile(w, "l1.jsonl", 0, ["l1"]);
    dayFile(w, "l2.jsonl", 0, ["l2"]);
    let release: () => void = () => {};
    let held = false;
    const hold = new Promise<void>((res) => (release = res));
    const a = boot(w, "a", {}, (path) => {
      if (!path.endsWith("l2.jsonl")) return undefined;
      held = true;
      return hold;
    });
    await pump(w, () => held);
    // another session takes the lease; the next heartbeat notices
    w.put(LEASE, JSON.stringify({ sessionId: "b", beatMs: w.time() }));
    await pump(w, () => a.last()?.owner === false, 1000);
    release();
    for (let i = 0; i < 10; i++) {
      await w.advance(10);
      await tick();
    }
    expect(indexWritesOf(a.v).length).toBe(0);
    expect(JSON.parse(w.text(LEASE)!).sessionId).toBe("b");
    a.s.stop();
  });

  test("a stopped scanner does not save when its pending read returns", async () => {
    const w = worldOf();
    await w.advance(100 * DAY_MS);
    dayFile(w, "s1.jsonl", 0, ["s1"]);
    let release: () => void = () => {};
    let held = false;
    const hold = new Promise<void>((res) => (release = res));
    const a = boot(w, "a", {}, (path) => {
      if (!path.endsWith("s1.jsonl")) return undefined;
      held = true;
      return hold;
    });
    await pump(w, () => held);
    a.s.stop();
    release();
    for (let i = 0; i < 10; i++) {
      await w.advance(10);
      await tick();
    }
    expect(indexWritesOf(a.v).length).toBe(0);
  });

  test("a scanner stopped while it acquires the lease never starts and frees the lease", async () => {
    const w = worldOf();
    seed(w);
    const a = boot(w, "a");
    a.s.stop();
    for (let i = 0; i < 80; i++) {
      await w.advance(1000);
      await tick();
    }
    expect(a.seen.length).toBe(0);
    expect(JSON.parse(w.text(LEASE)!).sessionId).toBe("");
  });

  test("an owner that lost the lease and got it back reloads its state from the index", async () => {
    const w = worldOf();
    await w.advance(100 * DAY_MS);
    dayFile(w, "r1.jsonl", 0, ["r1"]);
    const a = boot(w, "a");
    await pump(w, a.done);
    w.put(LEASE, JSON.stringify({ sessionId: "b", beatMs: w.time() }));
    await pump(w, () => a.last().owner === false, 1000);
    const reads = a.v.reads.length;
    const writes = a.v.writes.length;
    w.put(LEASE, JSON.stringify({ sessionId: "", beatMs: 0 }));
    const n = a.seen.length;
    await pump(w, () => a.seen.length > n && a.last().owner && a.done(), 1000);
    const head = `${projectDir(CFG, "-cur")}/HEAD.json`;
    expect(a.v.reads.slice(reads).some((r) => r.path === head)).toBe(true);
    expect(indexWritesOf({ writes: a.v.writes.slice(writes) }).length).toBe(0);
    a.s.stop();
  });

  test("a read that fails on a later chunk leaves no rows behind; the retry does not duplicate them", async () => {
    const w = worldOf();
    const p = `${ROOT}/-cur/big.jsonl`;
    const prompts = Array.from({ length: 2100 }, (_, i) => user(`${i} ${"p".repeat(2000)}`, { sessionId: "s1" }));
    w.put(p, [compactBoundary(), compactBoundary(), ...prompts, user("last", { sessionId: "s1" })].join("\n") + "\n");
    expect(w.size(p)!).toBeGreaterThan(4_194_304);
    w.setMtime(p, w.time() - HOURS);
    let armed = true;
    const a = boot(w, "a", {}, (path, offset) => {
      if (!armed || path !== p || offset === 0) return undefined;
      armed = false;
      return Promise.reject(new Error("EIO"));
    });
    await pump(w, a.done);
    expect(armed).toBe(false);
    await flush(w, a);
    const shard = (await shardOf(w, "-cur"))!;
    expect(shard.users.length).toBe(2101);
    expect(shard.compacts.length).toBe(2);
    a.s.stop();
  });

  test("a file that grows past a UTC midnight moves its state to the new day's bucket", async () => {
    const w = worldOf();
    await w.advance(100 * DAY_MS);
    const p = dayFile(w, "g.jsonl", 1, ["g1"]);
    const a = boot(w, "a");
    await pump(w, a.done);
    w.append(p, dated("g2", noon(w, 0)) + "\n");
    w.setMtime(p, noon(w, 0));
    await flush(w, a);
    const l = await loadBuckets(w.$, CFG, "-cur", w.time());
    if (l.kind !== "ok") throw new Error("index not ok");
    expect(Object.keys(l.days.get(dayIdx(noon(w, 1)))!.files)).toEqual([]);
    expect(Object.keys(l.days.get(dayIdx(noon(w, 0)))!.files)).toEqual([p]);
    expect(l.days.get(dayIdx(noon(w, 1)))!.usage.map((r) => r.requestId)).toEqual(["g1"]);
    expect(l.days.get(dayIdx(noon(w, 0)))!.usage.map((r) => r.requestId)).toEqual(["g2"]);
    a.s.stop();
  });

  test("a requestId that returns with more output on another day in a later pass moves its row", async () => {
    const w = worldOf();
    await w.advance(100 * DAY_MS);
    dayFile(w, "q.jsonl", 2, ["x"]);
    const a = boot(w, "a");
    await pump(w, a.done);
    const big = assistant({ requestId: "x", usage: { input_tokens: 10, output_tokens: 99, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, extra: { sessionId: "s1", timestamp: new Date(noon(w, 0)).toISOString() } });
    const later = `${ROOT}/-cur/later.jsonl`;
    w.put(later, big + "\n");
    w.setMtime(later, noon(w, 0));
    await flush(w, a);
    const l = await loadBuckets(w.$, CFG, "-cur", w.time());
    if (l.kind !== "ok") throw new Error("index not ok");
    // the first file keeps day 2 alive; its bucket must be rewritten without the superseded row
    expect(Object.keys(l.days.get(dayIdx(noon(w, 2)))!.files).length).toBe(1);
    expect(l.days.get(dayIdx(noon(w, 2)))!.usage).toEqual([]);
    expect(l.days.get(dayIdx(noon(w, 0)))!.usage.map((r) => `${r.requestId}:${r.tokens.output}`)).toEqual(["x:99"]);
    expect((await shardOf(w, "-cur"))!.usage.length).toBe(1);
    a.s.stop();
  });

  test("an older transcript read after a newer one does not overwrite its meta values", async () => {
    const w = worldOf();
    const newer = `${ROOT}/-cur/new.jsonl`;
    const older = `${ROOT}/-cur/old.jsonl`;
    w.put(newer, meta("ai-title", { aiTitle: "new title" }) + "\n");
    w.put(older, meta("ai-title", { aiTitle: "old title" }) + "\n");
    w.setMtime(newer, w.time() - HOURS);
    w.setMtime(older, w.time() - 2 * HOURS);
    const a = boot(w, "a");
    await pump(w, a.done);
    expect((await shardOf(w, "-cur"))!.metas.map((m) => m.value)).toEqual(["new title"]);
    a.s.stop();
  });
});
