import { describe, test, expect } from "claude-code/testing";
import { summarize, summarizeAsync } from "../core/summary.ts";
import { STEP_ROWS } from "../core/steps.ts";
import { activeHours, localDay, localDayStart, utcHour } from "../core/time.ts";
import { month, usage, NOW, OPUS, PRICES, SONNET, TZ } from "./fixtures/month.ts";
import type { Shard } from "../core/shard.ts";
import { read, req } from "./fixtures/rows.ts";
import type { UserRow } from "../core/types.ts";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const usd = (m: { usd: number }) => Math.round(m.usd * 1e6) / 1e6;
const usds = (rec: Record<string, { usd: number }>) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, usd(v)]));
const run = (extra: Partial<Parameters<typeof summarize>[2]> = {}, shards: Shard[] = month()) => summarize(shards, PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: TZ, ...extra });

describe("30d span", () => {
  const s = run();

  test("window starts at the first local midnight of the 30 days", () => {
    expect(s.from).toBe(Date.UTC(2026, 9, 29, 11));
    expect(s.to).toBe(NOW);
  });

  test("total and request counts: out-of-window and synthetic rows excluded", () => {
    expect(usd(s.total)).toBe(58);
    expect(s.total.requests).toBe(14);
    expect(s.total.tokens.input).toBe(2_700_000);
    expect(s.total.tokens.output).toBe(1_020_000);
    expect(s.total.tokens.cacheRead).toBe(27_000_000);
    expect(s.total.tokens.cw5m).toBe(1_080_000);
  });

  test("byModel", () => {
    expect(usds(s.byModel)).toEqual({ [OPUS]: 42, [SONNET]: 16, "claude-unknown-1": 0 });
    expect(s.byModel[OPUS].requests).toBe(6);
    expect(s.byModel["claude-unknown-1"].tokens.input).toBe(100_000);
  });

  test("unpriced lists unknown models once", () => {
    expect(s.unpriced).toEqual(["claude-unknown-1"]);
  });

  test("main and sub split by sidechain", () => {
    expect(usd(s.main)).toBe(47);
    expect(usd(s.sub)).toBe(11);
    expect(s.sub.requests).toBe(5);
    expect(near(s.main.usd + s.sub.usd, s.total.usd)).toBe(true);
  });

  test("fast is the doubled fast rows", () => {
    expect(usd(s.fast)).toBe(14);
    expect(s.fast.requests).toBe(1);
  });

  test("byRepo folds worktrees into the host repo", () => {
    expect(usds(s.byRepo)).toEqual({ alpha: 26, beta: 15, gamma: 17 });
  });

  test("subagent type x model with tool counts; a sub row without agentType reads as unknown", () => {
    expect(Object.keys(s.bySubType).sort()).toEqual(["Explore", "general-purpose", "unknown"]);
    expect(usd(s.bySubType.Explore[OPUS])).toBe(3.5);
    expect(s.bySubType.Explore[OPUS].tools).toEqual({ Bash: 1 });
    expect(usd(s.bySubType.Explore[SONNET])).toBe(2);
    expect(s.bySubType.Explore[SONNET].tools).toEqual({ Read: 1 });
    expect(usd(s.bySubType["general-purpose"][OPUS])).toBe(3.5);
    expect(s.bySubType["general-purpose"][OPUS].tools).toEqual({ Read: 2, mcp__docs__lookup: 1 });
    expect(usd(s.bySubType["general-purpose"][SONNET])).toBe(1);
    expect(usd(s.bySubType.unknown[SONNET])).toBe(1);
  });

  test("skill, plugin and MCP attribution", () => {
    expect(usds(s.bySkill)).toEqual({ brainstorm: 10.5 });
    expect(usds(s.byPlugin)).toEqual({ superpowers: 10.5 });
    expect(usd(s.byMcp.docs)).toBe(5.5);
    expect(s.byMcp.docs.calls).toBe(3);
    expect(s.byMcp.docs.requests).toBe(2);
  });

  test("timeline has 30 daily local-day buckets that sum to the total", () => {
    const t = s.timeline;
    expect(t.bucketMs).toBe(86_400_000);
    expect(t.points.length).toBe(30);
    const byIdx: Record<number, number> = {};
    t.points.forEach((p, i) => {
      if (p.usd || p.requests) byIdx[i] = usd(p);
    });
    // idx = local day - 2026-10-30; the 24h-clock hour 12:10Z is already local the 28th (idx 29)
    expect(byIdx).toEqual({ 0: 8, 7: 9.5, 11: 0, 13: 1, 21: 15, 28: 21, 29: 3.5 });
    expect(near(t.points.reduce((a, p) => a + p.usd, 0), s.total.usd)).toBe(true);
    expect(t.points.reduce((a, p) => a + p.requests, 0)).toBe(s.total.requests);
  });

  test("hourBands: nearest-rank p30/p50/p70/p90/max of tokens per local clock hour", () => {
    // Tokens per request unit: opus 1.16M, sonnet 1.19M. Nine local hours with a request, ascending:
    // 1.16 (r13), 1.16 (r11), 1.19 (r17), 1.19 (r15), 2.32 (r1), 4.70 (r8+r9), 5.83 (r5-r7), 5.95 (r10), 8.30 (r2-r4).
    // ranks: p30 = 3rd, p50 = 5th, p70 = 7th, p90 = 9th.
    expect(s.hourBands).toEqual([1_190_000, 2_320_000, 5_830_000, 8_300_000, 8_300_000]);
  });

  test("hourBands: an empty span is all zeros", () => {
    expect(run({ repo: "nope" }).hourBands).toEqual([0, 0, 0, 0, 0]);
  });

  test("hourBands: hours follow the zone offset, requests in one local hour add up", () => {
    // +330: 00:00Z and 00:29Z are both local 05:xx; 00:30Z is local 06:00.
    const mk = (id: string, ts: string, k: number) => usage({ id, session: "z", ts, model: SONNET, k, cwd: "/w/r" });
    const rows = [mk("h1", "2026-11-20T00:00:00Z", 1), mk("h2", "2026-11-20T00:29:00Z", 1), mk("h3", "2026-11-20T00:30:00Z", 1)];
    const sh: Shard = { v: 1, project: "q", files: {}, usage: rows, users: [], metas: [], compacts: [], snapshots: [] };
    expect(run({ tzOffsetMin: 330 }, [sh]).hourBands).toEqual([1_190_000, 1_190_000, 2_380_000, 2_380_000, 2_380_000]);
    expect(run({ tzOffsetMin: 0 }, [sh]).hourBands).toEqual([3_570_000, 3_570_000, 3_570_000, 3_570_000, 3_570_000]);
  });

  test("topSessions: usd descending, titles, PR, resume command", () => {
    const top = s.topSessions;
    expect(top.map((t) => t.sessionId)).toEqual(["s1", "s3", "s2", "s4", "s6", "s5"]);
    expect(top.map((t) => usd(t))).toEqual([16.5, 16, 15, 8.5, 1, 1]);
    expect(top[0]).toEqual({ sessionId: "s1", repo: "alpha", title: "Alpha custom", started: Date.parse("2026-10-30T02:00:00Z"), usd: 16.5, resume: "claude --resume s1" });
    expect(top[1].title).toBe("Gamma fast");
    expect(top[2].pr).toBe("https://example.test/pr/7");
    expect(top[2].repo).toBe("beta");
    expect("pr" in top[1]).toBe(false);
    expect("title" in top[4]).toBe(false);
  });

  test("boundary: a request exactly at the window start counts, 1 ms earlier does not", () => {
    expect(s.topSessions.some((t) => t.sessionId === "s6")).toBe(true);
    expect(s.topSessions.some((t) => t.sessionId === "s8")).toBe(false);
  });
});

describe("24h span", () => {
  const s = run({ span: "24h" });

  test("24 hourly buckets ending at the current hour", () => {
    expect(s.timeline.bucketMs).toBe(3_600_000);
    expect(s.timeline.points.length).toBe(24);
    expect(s.from).toBe(Date.UTC(2026, 10, 26, 13));
    const byIdx: Record<number, number> = {};
    s.timeline.points.forEach((p, i) => p.requests && (byIdx[i] = usd(p)));
    expect(byIdx).toEqual({ 7: 16, 21: 5, 23: 3.5 });
  });

  test("totals cover only the window", () => {
    expect(usd(s.total)).toBe(24.5);
    expect(s.total.requests).toBe(4);
    expect(usds(s.byRepo)).toEqual({ alpha: 8.5, gamma: 16 });
    expect(usd(s.sub)).toBe(0);
    expect(s.bySubType).toEqual({});
    expect(s.topSessions.map((t) => t.sessionId)).toEqual(["s3", "s4"]);
  });
});

describe("session span", () => {
  test("defaults to the session with the latest request, hourly buckets over it", () => {
    const s = run({ span: "session" });
    expect(s.topSessions.map((t) => t.sessionId)).toEqual(["s4"]);
    expect(usd(s.total)).toBe(8.5);
    expect(s.from).toBe(Date.parse("2026-11-27T10:15:00Z"));
    expect(s.to).toBe(Date.parse("2026-11-27T12:10:00Z"));
    expect(s.timeline.bucketMs).toBe(3_600_000);
    expect(s.timeline.points.map(usd)).toEqual([5, 0, 3.5]);
  });

  test("opts.sessionId picks another session", () => {
    const s = run({ span: "session", sessionId: "s2" });
    expect(usd(s.total)).toBe(15);
    expect(s.topSessions[0].pr).toBe("https://example.test/pr/7");
  });

  test("a session longer than 72 hours uses daily buckets", () => {
    const rows = [
      usage({ id: "a", session: "x", ts: "2026-11-01T01:00:00Z", model: SONNET, k: 1, cwd: "/w/r" }),
      usage({ id: "b", session: "x", ts: "2026-11-06T01:00:00Z", model: SONNET, k: 1, cwd: "/w/r" }),
    ];
    const sh: Shard = { v: 1, project: "q", files: {}, usage: rows, users: [], metas: [], compacts: [], snapshots: [] };
    const s = run({ span: "session" }, [sh]);
    expect(s.timeline.bucketMs).toBe(86_400_000);
    expect(s.timeline.points.length).toBe(6);
    expect(s.timeline.points.map(usd)).toEqual([1, 0, 0, 0, 0, 1]);
  });

  test("no rows gives an empty summary", () => {
    const s = run({ span: "session" }, []);
    expect(s.total.requests).toBe(0);
    expect(s.timeline.points.length).toBe(1);
  });
});

describe("sub-agent attribution", () => {
  test("two types in one session are told apart by row.agentType", () => {
    const rows = [
      usage({ id: "a", session: "x", ts: "2026-11-20T01:00:00Z", model: SONNET, k: 1, cwd: "/w/r", sidechain: true, agentType: "Plan" }),
      usage({ id: "b", session: "x", ts: "2026-11-20T01:05:00Z", model: SONNET, k: 2, cwd: "/w/r", sidechain: true, agentType: "Explore" }),
      usage({ id: "c", session: "x", ts: "2026-11-20T01:10:00Z", model: SONNET, k: 3, cwd: "/w/r", sidechain: true }),
    ];
    const sh: Shard = { v: 1, project: "q", files: {}, usage: rows, users: [], metas: [], compacts: [], snapshots: [] };
    const s = run({}, [sh]);
    expect(Object.keys(s.bySubType).sort()).toEqual(["Explore", "Plan", "unknown"]);
    expect(usd(s.bySubType.Plan[SONNET])).toBe(1);
    expect(usd(s.bySubType.Explore[SONNET])).toBe(2);
    expect(usd(s.bySubType.unknown[SONNET])).toBe(3);
  });
});

describe("repo filter", () => {
  test("keeps only that repo in every dimension", () => {
    const s = run({ repo: "alpha" });
    expect(usd(s.total)).toBe(26);
    expect(Object.keys(s.byRepo)).toEqual(["alpha"]);
    expect(Object.keys(s.byModel).sort()).toEqual([OPUS, SONNET]);
    expect(usd(s.sub)).toBe(5.5);
    expect(s.fast.requests).toBe(0);
    expect(s.topSessions.map((t) => t.sessionId)).toEqual(["s1", "s4", "s6"]);
    expect(s.unpriced).toEqual([]);
    expect(s.hourBands[4]).toBe(8_300_000);
  });

  test("unknown repo gives an empty summary", () => {
    const s = run({ repo: "nope" });
    expect(s.total.requests).toBe(0);
    expect(s.topSessions).toEqual([]);
  });
});

describe("topSessions cap", () => {
  test("at most 20, largest first", () => {
    const rows = Array.from({ length: 25 }, (_, i) => usage({ id: `q${i}`, session: `c${i}`, ts: "2026-11-20T00:00:00Z", model: SONNET, k: i + 1, cwd: "/w/r" }));
    const sh: Shard = { v: 1, project: "q", files: {}, usage: rows, users: [], metas: [], compacts: [], snapshots: [] };
    const s = run({}, [sh]);
    expect(s.topSessions.length).toBe(20);
    expect(s.topSessions[0].sessionId).toBe("c24");
    expect(s.topSessions[19].sessionId).toBe("c5");
  });
});

describe("time helpers", () => {
  test("utcHour and localDay", () => {
    expect(utcHour(Date.UTC(2026, 0, 1, 23, 59))).toBe(23);
    expect(utcHour(Date.UTC(2026, 0, 2, 0, 0))).toBe(0);
    expect(localDay(Date.UTC(2026, 0, 1, 12), 720)).toBe(localDay(Date.UTC(2026, 0, 2, 11, 59), 720));
    expect(localDay(Date.UTC(2026, 0, 1, 12), 720)).not.toBe(localDay(Date.UTC(2026, 0, 2, 12), 720));
    expect(localDayStart(Date.UTC(2026, 0, 1, 20), 780)).toBe(Date.UTC(2026, 0, 1, 11));
    expect(localDayStart(Date.UTC(2026, 0, 1, 20), -300)).toBe(Date.UTC(2026, 0, 1, 5));
  });

  test("activeHours counts distinct clock hours with a request", () => {
    const h = 3_600_000;
    const base = Date.UTC(2026, 0, 1);
    expect(activeHours([])).toBe(0);
    expect(activeHours([base, base + 59 * 60_000, base + h, base + 5 * h + 1, base + 5 * h + 2])).toBe(3);
  });

  test("activeHours with a half-hour zone counts local clock hours", () => {
    const base = Date.UTC(2026, 0, 1);
    const ts = [base, base + 29 * 60_000, base + 30 * 60_000, base + 59 * 60_000];
    expect(activeHours(ts)).toBe(1);
    expect(activeHours(ts, 330)).toBe(2);
  });
});

describe("summarize internals", () => {
  const shard = (usage: Shard["usage"], extra: Partial<Shard> = {}): Shard => ({ v: 1, project: "p", files: {}, usage, users: [], metas: [], compacts: [], snapshots: [], ...extra });
  const base = Date.UTC(2026, 10, 27, 10);

  test("a model's price is looked up once per summary, not once per request", () => {
    let touched = 0;
    const count = { get: (t: object, k: string | symbol) => (touched++, Reflect.get(t, k)), ownKeys: (t: object) => (touched++, Reflect.ownKeys(t)) };
    const models = new Proxy(PRICES.models, count);
    const rows = Array.from({ length: 300 }, (_, i) => ({ ...req({ id: `r${i}`, at: i * 1000, tokens: { cacheRead: 100 + i, output: 5 } }), ts: base + i * 1000 }));
    const s = summarize([shard(rows)], { ...PRICES, models }, { span: "24h", nowMs: base + 3_600_000, tzOffsetMin: 0 });
    expect(s.total.requests).toBe(300);
    expect(touched).toBeLessThan(20);
  });

  test("keys that are also Object.prototype members stay ordinary keys", () => {
    const rows = [
      { ...req({ id: "a", at: 0, session: "constructor", cwd: "/w/constructor", tokens: { input: 1000 }, tools: [read("t1", "constructor"), read("t2", "constructor")] }), ts: base, model: "constructor" },
      { ...req({ id: "b", at: 1000, session: "constructor", sidechain: true, agentType: "constructor", agentId: "a1", cwd: "/w/constructor", tokens: { input: 10 }, tools: [{ name: "constructor", inputChars: 1 }, { name: "constructor", inputChars: 1 }] }), ts: base + 1000, model: "toString" },
    ];
    const s = summarize([shard(rows, { compacts: [{ sessionId: "constructor", ts: base + 5 }] })], PRICES, { span: "24h", nowMs: base + 3_600_000, tzOffsetMin: 0 });
    expect(s.compactions).toEqual({ constructor: 1 });
    expect(s.peakContext).toEqual({ constructor: 1000 });
    expect(s.wholeReads).toEqual({ constructor: 2 });
    expect(Object.keys(s.byRepo)).toEqual(["constructor"]);
    expect(Object.keys(s.byModel).sort()).toEqual(["constructor", "toString"]);
    expect(s.bySubType.constructor.toString.tools.constructor).toBe(2);
  });
});

describe("subStats", () => {
  const shard = (usage: Shard["usage"], extra: Partial<Shard> = {}): Shard => ({ v: 1, project: "p", files: {}, usage, users: [], metas: [], compacts: [], snapshots: [], ...extra });
  const base = Date.UTC(2026, 10, 27, 10);
  const at = (n: number) => base + n * 1000;
  const sub = (id: string, n: number, agentType: string, agentId: string, session = "s") => ({ ...req({ id, at: 0, session, sidechain: true, agentType, agentId, cwd: "/w/r", tokens: { output: 10 } }), ts: at(n) });
  const res = (n: number, agentId: string, count: number, errors: number, session = "s"): UserRow => ({ sessionId: session, ts: at(n), kind: "toolResult", chars: 3, toolUseId: `u${n}`, results: Array.from({ length: count }, (_, i) => ({ toolUseId: `u${n}-${i}`, chars: 1 })), sidechain: true, agentId, ...(errors > 0 ? { errors } : {}) });
  const opts = { span: "24h" as const, nowMs: base + 3_600_000, tzOffsetMin: 0 };

  test("tasks are distinct sub-agent conversations; results and errors sum over their tool-result rows", () => {
    const rows = [sub("a", 1, "Explore", "e1"), sub("b", 2, "Explore", "e1"), sub("c", 3, "Explore", "e2"), sub("d", 4, "Plan", "p1"), sub("e", 5, "Plan", "p1", "other")];
    const users = [res(2, "e1", 2, 1), res(3, "e2", 1, 0), res(4, "p1", 3, 0), res(5, "p1", 1, 1, "other")];
    const s = summarize([shard(rows, { users })], PRICES, opts);
    expect({ ...s.subStats }).toEqual({ Explore: { tasks: 2, results: 3, errors: 1 }, Plan: { tasks: 2, results: 4, errors: 1 } });
  });
  test("a conversation outside the window or filtered repo does not count; main-thread rows never do", () => {
    const old = { ...sub("x", 0, "Explore", "e9"), ts: base - 3 * 86_400_000 };
    const main = { ...req({ id: "m", at: 0, cwd: "/w/r" }), ts: at(1) };
    const users: UserRow[] = [{ ...res(2, "e9", 4, 4), ts: base - 3 * 86_400_000 }, { sessionId: "s", ts: at(3), kind: "toolResult", chars: 1, results: [{ toolUseId: "z", chars: 1 }], errors: 1 }];
    const s = summarize([shard([old, main], { users })], PRICES, opts);
    expect({ ...s.subStats }).toEqual({});
  });
  test("rows without an agentId (shards from before it existed) yield no tasks", () => {
    const row = { ...req({ id: "a", at: 0, sidechain: true, agentType: "Explore", cwd: "/w/r" }), ts: at(1) };
    expect({ ...summarize([shard([row])], PRICES, opts).subStats }).toEqual({});
  });
});

describe("summarizeAsync", () => {
  const opts = { span: "30d" as const, nowMs: NOW, tzOffsetMin: TZ };

  test("gives exactly the Summary of summarize on the month fixture", async () => {
    let ticks = 0;
    const a = await summarizeAsync(month(), PRICES, opts, () => void ticks++);
    expect(a).toEqual(summarize(month(), PRICES, opts));
    expect(ticks).toBeGreaterThan(0);
  });

  test("every span and a repo filter match the sync Summary", async () => {
    for (const o of [{ ...opts, span: "24h" as const }, { ...opts, span: "session" as const }, { ...opts, repo: "alpha" }]) {
      expect(await summarizeAsync(month(), PRICES, o, async () => {})).toEqual(summarize(month(), PRICES, o));
    }
  });

  test("ticks many times when the rows cross STEP_ROWS, and each tick lets a pending task run", async () => {
    const rows = Array.from({ length: STEP_ROWS * 5 }, (_, i) =>
      req({ id: `r${i}`, session: `s${i % 7}`, at: i * 1000, tokens: { input: 10, output: 5, cacheRead: 1000, cw5m: i % 50 === 0 ? 30_000 : 0 }, cwd: "/w/alpha" }),
    );
    const shard: Shard = { v: 1, project: "p", files: {}, usage: rows, users: [], metas: [], compacts: [], snapshots: [] };
    const big = { ...opts, nowMs: rows[rows.length - 1].ts + 1000 };
    let ticks = 0;
    let ran = 0;
    const a = await summarizeAsync([shard], PRICES, big, async () => {
      ticks++;
      await Promise.resolve().then(() => void ran++);
    });
    expect(ticks).toBeGreaterThan(10);
    expect(ran).toBe(ticks);
    expect(a).toEqual(summarize([shard], PRICES, big));
    expect(a.total.requests).toBe(STEP_ROWS * 5);
  });
});
