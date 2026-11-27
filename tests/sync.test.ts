import { describe, test, expect } from "claude-code/testing";
import { MACHINE_FILE_MAX, buildMachineFile, buildMachineFileAsync, encodeMachineFile, mergeMachines, parseMachineFile, repoAlias } from "../core/sync.ts";
import type { HourCell, MachineFile } from "../core/sync.ts";
import { hmacSha256Hex } from "../core/sha256.ts";
import { summarize } from "../core/summary.ts";
import type { Money, Summary } from "../core/summary.ts";
import type { Hint } from "../core/hint.ts";
import type { Shard } from "../core/shard.ts";
import { utf8Length } from "../core/lines.ts";
import { STEP_ROWS } from "../core/steps.ts";
import { DAY_MS, HOUR_MS } from "../core/time.ts";
import { month, NOW, PRICES, TZ, usage } from "./fixtures/month.ts";
import type { Spec } from "./fixtures/month.ts";

type Detail = "numbers" | "repos" | "full";
const SALT = "test-salt";
const settings = (shareDetail: Detail, machineName = "box-a", redactEvidence = false) => ({ shareDetail, machineName, redactEvidence });
const build = (shards: Shard[], detail: Detail, machineName = "box-a", extra?: Parameters<typeof buildMachineFile>[5]) => buildMachineFile(shards, PRICES, settings(detail, machineName), SALT, NOW, extra);
const span = (shards: Shard[], s: "24h" | "30d" = "30d") => summarize(shards, PRICES, { span: s, nowMs: NOW, tzOffsetMin: TZ });
const [P1, P2] = month();
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const eqMoney = (a: Money, b: Money) => {
  expect(a.requests).toBe(b.requests);
  expect(a.tokens).toEqual(b.tokens);
  expect(near(a.usd, b.usd)).toBe(true);
};
const eqRec = (a: Record<string, Money>, b: Record<string, Money>) => {
  expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  for (const k of Object.keys(b)) eqMoney(a[k], b[k]);
};
const hint = (detail: string): Hint => ({ rule: "demo-rule", title: "Demo", usd: 1, summary: "s", action: "a", short: "d", evidence: [{ label: "Cmd", detail, kind: "command" }] });
const cell = (over: Partial<HourCell> = {}): HourCell => ({ h: Math.floor(NOW / HOUR_MS) - 5, model: "claude-opus-5-5", repo: "r-aaaaaaaaaa", sub: null, fast: false, tokens: { input: 10, output: 2, cacheRead: 100, cw5m: 4, cw1h: 0 }, usd: 0.5, requests: 1, ...over });
const handFile = (over: Partial<MachineFile> = {}): MachineFile => ({ v: 1, machine: "box-b", detail: "numbers", writtenAt: NOW, hours: [cell()], ...over });

describe("repoAlias", () => {
  test("is r- plus the first 10 hex chars of the HMAC, the same on every machine for one salt", () => {
    const a = repoAlias("demo-repo", SALT);
    expect(a).toBe(`r-${hmacSha256Hex(SALT, "demo-repo").slice(0, 10)}`);
    expect(a).toMatch(/^r-[0-9a-f]{10}$/);
    expect(repoAlias("demo-repo", SALT)).toBe(a);
    expect(repoAlias("demo-repo", "other-salt")).not.toBe(a);
    expect(repoAlias("demo-repo-2", SALT)).not.toBe(a);
  });

  test("two machines holding one repo write the same alias", () => {
    const fa = build([P1], "numbers", "box-a");
    const fb = build([P1], "numbers", "box-b");
    expect(fa.hours.map((c) => c.repo)).toEqual(fb.hours.map((c) => c.repo));
    expect(fa.hours.some((c) => c.repo === repoAlias("alpha", SALT))).toBe(true);
  });
});

describe("buildMachineFile: detail levels", () => {
  test("numbers: no repo name, session title, PR link or path in the serialized file; aliases and sub-agent types stay", () => {
    const text = encodeMachineFile(build([P1, P2], "numbers"));
    for (const secret of ["alpha", "beta", "gamma", "Alpha", "Beta work", "Gamma fast", "/work", "worktrees", "example.test", "resume", "claude --resume"]) expect(text.includes(secret)).toBe(false);
    expect(text.includes(repoAlias("alpha", SALT))).toBe(true);
    expect(text.includes("Explore")).toBe(true);
    const f = JSON.parse(text) as MachineFile;
    expect(f.sessions).toBeUndefined();
    expect(f.hints).toBeUndefined();
    expect(f.toolFill).toBeUndefined();
    expect(f.detail).toBe("numbers");
  });

  test("numbers: a worktree folds into the host repo alias", () => {
    const f = build([P2], "numbers");
    const aliases = new Set(f.hours.map((c) => c.repo));
    expect(aliases.has(repoAlias("alpha", SALT))).toBe(true);
    expect(aliases.size).toBe(2);
  });

  test("repos: real repo names, still no titles or paths", () => {
    const text = encodeMachineFile(build([P1, P2], "repos"));
    for (const name of ["alpha", "beta", "gamma"]) expect(text.includes(`"${name}"`)).toBe(true);
    for (const secret of ["Alpha custom", "Beta work", "Gamma fast", "/work", "worktrees", "example.test", "claude --resume"]) expect(text.includes(secret)).toBe(false);
    expect(JSON.parse(text).sessions).toBeUndefined();
  });

  test("full: sessions with titles, hints and tool fill", () => {
    const f = build([P1, P2], "full", "box-a", { hints: [hint("npm test --coverage")], toolFill: { Read: 500 } });
    expect(f.sessions?.find((s) => s.sessionId === "s1")?.title).toBe("Alpha custom");
    expect(f.sessions?.find((s) => s.sessionId === "s2")?.pr).toBe("https://example.test/pr/7");
    expect(f.sessions?.[0].usd).toBeGreaterThanOrEqual(f.sessions?.[1].usd ?? 0);
    expect(f.hints?.[0].evidence[0].detail).toBe("npm test --coverage");
    expect(f.toolFill).toEqual({ Read: 500 });
    expect(f.hours.some((c) => c.repo === "alpha")).toBe(true);
  });

  test("full with redactEvidence: hint evidence is redacted and session titles are dropped", () => {
    const f = buildMachineFile([P1, P2], PRICES, settings("full", "box-a", true), SALT, NOW, { hints: [hint("npm test --coverage")] });
    expect(f.hints?.[0].evidence[0].detail).toBe("npm");
    expect(encodeMachineFile(f).includes("Alpha custom")).toBe(false);
    expect(f.sessions?.length).toBeGreaterThan(0);
  });

  test("hours: UTC hour index, one cell per model, repo, sub-agent type and fast flag; synthetic rows are skipped", () => {
    const f = build([P1, P2], "repos");
    const total = f.hours.reduce((s, c) => s + c.requests, 0);
    expect(total).toBe(16);
    const r6 = f.hours.find((c) => c.h === Math.floor(Date.parse("2026-11-20T08:10:00Z") / HOUR_MS) && c.sub !== null);
    expect(r6).toMatchObject({ model: "claude-opus-5-5", repo: "beta", sub: "general-purpose", fast: false });
    expect(f.hours.find((c) => c.fast)?.repo).toBe("gamma");
    expect(f.hours.some((c) => c.sub === "unknown")).toBe(true);
    expect(f.writtenAt).toBe(NOW);
    expect(f.machine).toBe("box-a");
    const sorted = f.hours.map((c) => c.h);
    expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
  });
});

describe("buildMachineFile: size cap", () => {
  test("a file over 4 MiB drops the oversized optional section and records it", () => {
    const big = Array.from({ length: 30 }, (_, i) => hint("x".repeat(200_000) + i));
    const f = build([P1, P2], "full", "box-a", { hints: big, toolFill: { Read: 5 } });
    expect(utf8Length(encodeMachineFile(f))).toBeLessThanOrEqual(MACHINE_FILE_MAX);
    expect(f.hints).toBeUndefined();
    expect(f.omitted).toEqual(["hints"]);
    expect(f.sessions?.length).toBeGreaterThan(0);
    expect(f.toolFill).toEqual({ Read: 5 });
    // Optional sections go before any hour.
    expect(f.hours).toEqual(build([P1, P2], "repos").hours);
    expect(f.hoursFrom).toBeUndefined();
  });

  test("when the hours alone are too many, the oldest go and hoursFrom marks the cut", () => {
    const shard: Shard = { v: 1, project: "big", files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    shard.usage = Array.from({ length: 40_000 }, (_, i) => usage({ id: `q${i}`, session: "s", ts: new Date(NOW - 3 * HOUR_MS - i * 1000).toISOString(), model: "claude-opus-5-5", k: 1, cwd: `/w/some-long-repo-name-${i}` } as Spec));
    const f = build([shard], "repos");
    const text = encodeMachineFile(f);
    expect(utf8Length(text)).toBeLessThanOrEqual(MACHINE_FILE_MAX);
    expect(utf8Length(text)).toBeGreaterThan(MACHINE_FILE_MAX - 1000);
    expect(f.hours.length).toBeLessThan(40_000);
    expect(f.hoursFrom).toBe(f.hours[0].h);
    expect(f.omitted ?? []).toEqual([]);
    // The newest cells survive.
    expect(f.hours[f.hours.length - 1].h).toBe(Math.floor((NOW - 3 * HOUR_MS) / HOUR_MS));
    const m = mergeMachines(span([P1]), [f], TZ);
    expect(m.localOnly).toContain("hours");
  });

  test("async build gives the same file and hands control back between steps", async () => {
    const shard: Shard = { v: 1, project: "many", files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    shard.usage = Array.from({ length: STEP_ROWS * 3 + 5 }, (_, i) => usage({ id: `q${i}`, session: `s${i % 9}`, ts: new Date(NOW - (i % 50) * HOUR_MS).toISOString(), model: "claude-opus-5-5", k: 1, cwd: `/w/r${i % 40}` } as Spec));
    let ticks = 0;
    const a = await buildMachineFileAsync([shard], PRICES, settings("full"), SALT, NOW, undefined, () => {
      ticks++;
    });
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(a).toEqual(buildMachineFile([shard], PRICES, settings("full"), SALT, NOW));
  });

  const rowsShard = (rows: number, cwd: (i: number) => string): Shard => {
    const shard: Shard = { v: 1, project: "gen", files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    shard.usage = Array.from({ length: rows }, (_, i) => usage({ id: `q${i}`, session: "s", ts: new Date(NOW - HOUR_MS).toISOString(), model: "claude-opus-5-5", k: 1, cwd: cwd(i) } as Spec));
    return shard;
  };
  const countTicks = async (shard: Shard, detail: Detail): Promise<{ ticks: number; file: MachineFile }> => {
    let ticks = 0;
    const file = await buildMachineFileAsync([shard], PRICES, settings(detail), SALT, NOW, undefined, () => {
      ticks++;
    });
    return { ticks, file };
  };

  test("the final fit pass yields per chunk of cells, not in one unsliced run", async () => {
    const chunks = 4;
    const shard = rowsShard(STEP_ROWS * chunks, (i) => `/w/repo-${i}`);
    const { ticks, file } = await countTicks(shard, "repos");
    expect(file.hours.length).toBe(STEP_ROWS * chunks);
    // chunks ticks in the row loop, 2 phase ticks, and at least chunks more while sizing the cells.
    expect(ticks).toBeGreaterThanOrEqual(2 * chunks + 2);
    expect(file).toEqual(buildMachineFile([shard], PRICES, settings("repos"), SALT, NOW));
  });

  test("hashing a burst of new repos inside one STEP_ROWS window is metered", async () => {
    const rows = STEP_ROWS - 1;
    const many = await countTicks(rowsShard(rows, (i) => `/w/repo-${i}`), "numbers");
    const one = await countTicks(rowsShard(rows, () => "/w/repo-0"), "numbers");
    expect(many.ticks).toBeGreaterThan(one.ticks + 5);
    expect(many.file).toEqual(buildMachineFile([rowsShard(rows, (i) => `/w/repo-${i}`)], PRICES, settings("numbers"), SALT, NOW));
  });
});

describe("parseMachineFile", () => {
  test("round-trips a built file", () => {
    const f = build([P1, P2], "full", "box-a", { hints: [hint("ls")], toolFill: { Read: 3 } });
    expect(parseMachineFile(encodeMachineFile(f))).toEqual(f);
  });

  test("negative: wrong version, bad detail, broken JSON, damaged cells and sections are refused", () => {
    const ok = handFile();
    expect(parseMachineFile(JSON.stringify(ok))).toEqual(ok);
    expect(parseMachineFile("{")).toBeNull();
    expect(parseMachineFile("[]")).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...ok, v: 2 }))).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...ok, detail: "everything" }))).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...ok, machine: 7 }))).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...ok, hours: [{ ...cell(), usd: "1" }] }))).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...ok, hours: [{ ...cell(), tokens: { input: 1 } }] }))).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...ok, hours: [{ ...cell(), sub: 3 }] }))).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...ok, detail: "full", sessions: [{ sessionId: 1 }] }))).toBeNull();
    expect(parseMachineFile(JSON.stringify({ ...ok, detail: "full", toolFill: { Read: "x" } }))).toBeNull();
  });
});

describe("mergeMachines", () => {
  test("totals are the sum: local p1 plus a repos file of p2 equals the summary of both", () => {
    const want = span([P1, P2]);
    const m = mergeMachines(span([P1]), [build([P2], "repos", "box-b")], TZ);
    eqMoney(m.total, want.total);
    eqMoney(m.main, want.main);
    eqMoney(m.sub, want.sub);
    eqMoney(m.fast, want.fast);
    eqRec(m.byModel, want.byModel);
    eqRec(m.byRepo, want.byRepo);
    expect(m.timeline.points.length).toBe(want.timeline.points.length);
    m.timeline.points.forEach((p, i) => eqMoney(p, want.timeline.points[i]));
    expect(Object.keys(m.bySubType).sort()).toEqual(Object.keys(want.bySubType).sort());
    for (const t of Object.keys(want.bySubType)) eqRec(m.bySubType[t], want.bySubType[t]);
    expect(m.localOnly).toEqual(["topSessions", "toolFill"]);
  });

  test("the 24h span merges too", () => {
    const want = span([P1, P2], "24h");
    const m = mergeMachines(span([P1], "24h"), [build([P2], "numbers", "box-b")], TZ);
    eqMoney(m.total, want.total);
    m.timeline.points.forEach((p, i) => eqMoney(p, want.timeline.points[i]));
    expect(want.total.requests).toBeGreaterThan(0);
  });

  test("numbers: totals merge, byRepo stays local-only and is listed", () => {
    const local = span([P1]);
    const m = mergeMachines(local, [build([P2], "numbers", "box-b")], TZ);
    eqMoney(m.total, span([P1, P2]).total);
    eqRec(m.byRepo, local.byRepo);
    expect(m.localOnly).toEqual(["byRepo", "topSessions", "toolFill"]);
  });

  test("local full, remote numbers: localOnly includes topSessions", () => {
    const m = mergeMachines(span([P1]), [build([P2], "numbers", "box-b")], TZ);
    expect(m.localOnly).toContain("topSessions");
    expect(m.topSessions.map((s) => s.sessionId)).toEqual(span([P1]).topSessions.map((s) => s.sessionId));
  });

  test("full: top sessions and tool fill merge; nothing is local-only", () => {
    const want = span([P1, P2]);
    const local = { ...span([P1]), toolFill: { Read: 10, Bash: 1 } };
    const remote = build([P2], "full", "box-b", { toolFill: { Read: 100, Grep: 7 } });
    const m = mergeMachines(local, [remote], TZ);
    expect(m.localOnly).toEqual([]);
    expect(m.topSessions.map((s) => [s.sessionId, s.title, s.repo])).toEqual(want.topSessions.map((s) => [s.sessionId, s.title, s.repo]));
    expect(m.topSessions.map((s) => near(s.usd, want.topSessions.find((w) => w.sessionId === s.sessionId)?.usd ?? -1))).toEqual(m.topSessions.map(() => true));
    expect({ ...m.toolFill }).toEqual({ Read: 110, Bash: 1, Grep: 7 });
    eqRec(m.byRepo, want.byRepo);
  });

  test("a file that dropped its sessions lists topSessions as local-only", () => {
    const { sessions: _dropped, ...rest } = build([P2], "full", "box-b");
    const f: MachineFile = { ...rest, omitted: ["sessions"] };
    expect(mergeMachines(span([P1]), [f], TZ).localOnly).toEqual(["topSessions", "toolFill"]);
  });

  test("hours land in the viewer's local day: 10:00Z is the previous local day, 12:00Z the next (NZDT)", () => {
    const local = span([P1]);
    const day = DAY_MS;
    const h = (iso: string) => Math.floor(Date.parse(iso) / HOUR_MS);
    const f = handFile({ hours: [cell({ h: h("2026-11-26T10:00:00Z"), requests: 1, usd: 1 }), cell({ h: h("2026-11-26T12:00:00Z"), requests: 2, usd: 2 })] });
    const m = mergeMachines({ ...local, timeline: { bucketMs: day, points: local.timeline.points.map((p) => ({ ...p, usd: 0, requests: 0 })) } }, [f], TZ);
    const at = (iso: string) => Math.floor((Date.parse(iso) - local.from) / day);
    const prev = at("2026-11-25T11:00:00Z");
    const next = at("2026-11-26T11:00:00Z");
    expect(m.timeline.points[prev].requests).toBe(1);
    expect(m.timeline.points[next].requests).toBe(2);
    expect(prev).not.toBe(next);
  });

  test("negative: cells outside the span add nothing; a session span is returned as is", () => {
    const old = cell({ h: Math.floor(Date.parse("2026-09-01T00:00:00Z") / HOUR_MS) });
    const future = cell({ h: Math.floor(NOW / HOUR_MS) + 3 });
    const local = span([P1]);
    const m = mergeMachines(local, [handFile({ hours: [old, future] })], TZ);
    eqMoney(m.total, local.total);
    const ses = summarize([P1], PRICES, { span: "session", nowMs: NOW, tzOffsetMin: TZ });
    const m2 = mergeMachines(ses, [handFile()], TZ);
    expect(m2.total).toEqual(ses.total);
    expect(m2.localOnly).toEqual([]);
  });

  test("this machine's own file is skipped by name; of two files from one machine the newer wins", () => {
    const local = span([P1]);
    const self = handFile({ machine: "box-a" });
    eqMoney(mergeMachines(local, [self], TZ, "box-a").total, local.total);
    const older = handFile({ writtenAt: NOW - 1000, hours: [cell({ requests: 5, usd: 5 })] });
    const newer = handFile({ writtenAt: NOW, hours: [cell({ requests: 1, usd: 1 })] });
    const m = mergeMachines(local, [older, newer], TZ);
    expect(m.total.requests).toBe(local.total.requests + 1);
    expect(m.total.requests).toBe(mergeMachines(local, [newer, older], TZ).total.requests);
  });

  test("the local summary is not mutated, and no files means no changes and nothing local-only", () => {
    const local = span([P1]);
    const before = JSON.stringify(local);
    const m = mergeMachines(local, [build([P2], "full", "box-b")], TZ);
    expect(JSON.stringify(local)).toBe(before);
    expect(m.total).not.toBe(local.total);
    const none = mergeMachines(local, [], TZ);
    expect(none.localOnly).toEqual([]);
    expect(JSON.stringify({ ...none, localOnly: undefined })).toBe(before);
  });

  test("keys like __proto__ and constructor in a file are plain keys", () => {
    const f = handFile({ detail: "repos", hours: [cell({ repo: "__proto__", model: "constructor", sub: "toString" })] });
    const m = mergeMachines(span([P1]), [f], TZ) as Summary & { localOnly: string[] };
    expect(m.byRepo["__proto__"].requests).toBe(1);
    expect(m.byModel["constructor"].requests).toBe(1);
    expect(m.bySubType["toString"]["constructor"].requests).toBe(1);
    expect(({} as Record<string, unknown>).requests).toBeUndefined();
  });
});
