import { describe, test, expect } from "claude-code/testing";
import { analyzeFlow, PASTE_MIN_TOKENS, FLOW_ITEMS } from "../core/flow.ts";
import { summarize } from "../core/summary.ts";
import { PRICES } from "./fixtures/month.ts";
import { READ_USD, T0, MIN, bash, inAgent, notice, prompt, read, req, result, summary } from "./fixtures/rows.ts";
import type { Shard } from "../core/shard.ts";
import type { CompactRow, UsageRow, UserRow } from "../core/types.ts";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const run = (rows: UsageRow[], users: UserRow[] = [], compacts: CompactRow[] = [], counted: (r: UsageRow) => boolean = () => true) =>
  analyzeFlow({ rows, users, compacts, counted, cacheReadUsd: () => READ_USD });
const item = (out: ReturnType<typeof run>, source: string, label: string) => out.flow.find((f) => f.source === source && f.label === label);

// One main-thread session: a 100 token prompt, a 1000 token whole Read, a compaction, then two more requests.
//   r1 prompt 1100 (fixed 1000 + prompt 100) | r2 prompt 2150 | r3 prompt 2200 | compact | r4 prompt 1500 (fixed 1000 + summary 500) | r5 re-reads all 1500
const story = () => ({
  rows: [
    req({ id: "r1", at: 1 * MIN, tokens: { input: 100, cw5m: 1000, output: 50 }, tools: [read("t1", "/a.ts")] }),
    req({ id: "r2", at: 3 * MIN, tokens: { cacheRead: 1150, cw5m: 1000, output: 50 } }),
    req({ id: "r3", at: 4 * MIN, tokens: { cacheRead: 2200 } }),
    req({ id: "r4", at: 7 * MIN, tokens: { cw5m: 1500, output: 10 } }),
    req({ id: "r5", at: 8 * MIN, tokens: { cacheRead: 1500 } }),
  ],
  users: [prompt(0, 400), result(2 * MIN, "t1", 4000), summary(6 * MIN + 1, 2000)],
  compacts: [{ sessionId: "s", ts: T0 + 6 * MIN }],
});

describe("flow", () => {
  test("each part's re-read cost stops at the compaction", () => {
    const s = story();
    const out = run(s.rows, s.users, s.compacts);
    expect(item(out, "read", "/a.ts")?.tokens).toBe(1000);
    // Re-read by r3 only: held after r2, released by the compaction before r4 and r5.
    expect(near(item(out, "read", "/a.ts")?.rereadUsd ?? -1, 1000 * READ_USD)).toBe(true);
    expect(near(item(out, "prompt", "hello")?.rereadUsd ?? -1, 200 * READ_USD)).toBe(true);
  });

  test("fixed part is the first request's prompt minus what arrived with it, and is rebuilt after the compaction", () => {
    const s = story();
    const out = run(s.rows, s.users, s.compacts);
    const fixed = item(out, "fixed", "fixed part");
    expect(fixed?.tokens).toBe(2000);
    expect(near(fixed?.rereadUsd ?? -1, 3000 * READ_USD)).toBe(true);
  });

  test("the compaction summary is its own part, re-read by the requests after it", () => {
    const s = story();
    const c = item(run(s.rows, s.users, s.compacts), "compaction", "compaction");
    expect(c?.tokens).toBe(500);
    expect(near(c?.rereadUsd ?? -1, 500 * READ_USD)).toBe(true);
  });

  test("items are sorted by re-read cost and capped", () => {
    const s = story();
    const out = run(s.rows, s.users, s.compacts);
    expect(out.flow.map((f) => f.label)).toEqual(["fixed part", "/a.ts", "compaction", "hello"]);
    expect(FLOW_ITEMS).toBe(40);
    const many = Array.from({ length: 60 }, (_, i) => req({ id: `m${i}`, at: i * 1000, tokens: { input: 10 }, tools: [bash(`b${i}`, `cmd ${i}`)] }));
    const users = Array.from({ length: 60 }, (_, i) => result(i * 1000 + 1, `b${i}`, 400));
    expect(run(many, users).flow.length).toBe(40);
  });

  test("chars/4 is scaled to the API's token count of what arrived", () => {
    // 8000 chars = 2000 estimated tokens but the whole prompt is 1000: scaled by 0.5.
    const out = run([req({ id: "a", at: 1, tokens: { input: 1000 } }), req({ id: "b", at: 2, tokens: { cacheRead: 1000 } })], [prompt(0, 8000)]);
    expect(item(out, "prompt", "hello")?.tokens).toBe(1000);
    expect(near(item(out, "prompt", "hello")?.rereadUsd ?? -1, 1000 * READ_USD)).toBe(true);
  });

  test("later requests scale by the prompt growth, clamped to 0.25..4", () => {
    // b's growth is 2000 over 10000 estimated tokens: 0.2 clamps to 0.25.
    const down = run(
      [req({ id: "a", at: 1, tokens: { input: 1000 }, tools: [read("t1", "/big")] }), req({ id: "b", at: 3, tokens: { cacheRead: 1000, input: 2000 } })],
      [result(2, "t1", 40_000)],
    );
    expect(item(down, "read", "/big")?.tokens).toBe(2500);
    // Growth 100000 over 1000 estimated tokens clamps to 4.
    const up = run(
      [req({ id: "a", at: 1, tokens: { input: 1000 }, tools: [read("t1", "/small")] }), req({ id: "b", at: 3, tokens: { cacheRead: 1000, input: 100_000 } })],
      [result(2, "t1", 4000)],
    );
    expect(item(up, "read", "/small")?.tokens).toBe(4000);
  });

  test("sources: read target, bash command line, mcp tool, other tool, unpaired result, notices as prompt parts", () => {
    const rows = [
      req({
        id: "a",
        at: 10,
        tokens: { input: 5000 },
        tools: [
          read("t1", "/r.ts"),
          bash("t2", "npm test\nand more"),
          { name: "mcp__srv__q", mcpServer: "srv", id: "t3", inputChars: 3 },
          { name: "Grep", id: "t4", target: "foo", inputChars: 3 },
        ],
      }),
      req({ id: "b", at: 20, tokens: { cacheRead: 5000, input: 600 } }),
    ];
    const users = [result(11, "t1", 400), result(12, "t2", 400), result(13, "t3", 400), result(14, "t4", 400), result(15, "zz", 400), notice(16, 400)];
    const out = run(rows, users);
    expect(item(out, "read", "/r.ts")?.tokens).toBe(100);
    expect(item(out, "bash", "npm test")?.tokens).toBe(100);
    expect(item(out, "mcp", "mcp__srv__q")?.tokens).toBe(100);
    expect(item(out, "tool", "Grep")?.tokens).toBe(100);
    expect(item(out, "tool", "tool result")?.tokens).toBe(100);
    expect(item(out, "prompt", "notices")?.tokens).toBe(100);
  });

  test("uncounted requests re-read nothing and add nothing, but still hold their parts for later counted ones", () => {
    const s = story();
    const out = run(s.rows, s.users, s.compacts, (r) => r.requestId === "r3");
    // r3 alone re-reads the fixed part (1000) and the read (1000); nothing was added by the uncounted requests.
    expect(item(out, "fixed", "fixed part")?.tokens).toBe(0);
    expect(near(item(out, "fixed", "fixed part")?.rereadUsd ?? -1, 1000 * READ_USD)).toBe(true);
    expect(item(out, "compaction", "compaction")).toBeUndefined();
    expect(near(item(out, "read", "/a.ts")?.rereadUsd ?? -1, 1000 * READ_USD)).toBe(true);
    expect(item(out, "read", "/a.ts")?.tokens).toBe(0);
  });

  const side = (id: string, at: number, agentId: string, tokens: Partial<UsageRow["tokens"]>, extra: Partial<Parameters<typeof req>[0]> = {}) =>
    req({ id, at, tokens, agentType: "Explore", agentId, sidechain: true, ...extra });

  test("a sub-agent transcript is a stream of its own, next to the main one", () => {
    const rows = [
      req({ id: "m1", at: 1, tokens: { input: 1000 } }),
      req({ id: "m2", at: 20, tokens: { cacheRead: 1000 } }),
      side("x1", 5, "a1", { input: 2000 }),
      side("x2", 8, "a1", { cacheRead: 2000 }),
      side("x3", 9, "a1", { cacheRead: 2000 }),
    ];
    const out = run(rows, [prompt(0, 400), inAgent(prompt(4, 4000, "sub task"), "a1")]);
    expect(item(out, "prompt", "sub task")?.tokens).toBe(1000);
    expect(near(item(out, "prompt", "sub task")?.rereadUsd ?? -1, 2000 * READ_USD)).toBe(true);
    expect(item(out, "fixed", "fixed part (Explore)")?.tokens).toBe(1000);
    expect(near(item(out, "fixed", "fixed part (Explore)")?.rereadUsd ?? -1, 2000 * READ_USD)).toBe(true);
    // The main stream is untouched by the sub-agent's rows.
    expect(item(out, "fixed", "fixed part")?.tokens).toBe(900);
    expect(item(out, "prompt", "hello")?.tokens).toBe(100);
    expect(near(item(out, "prompt", "hello")?.rereadUsd ?? -1, 100 * READ_USD)).toBe(true);
  });

  test("two sub-agents of one type that run side by side each carry their own fixed part", () => {
    const out = run([side("x1", 5, "a1", { input: 1000 }), side("y1", 6, "a2", { input: 1000 }), side("x2", 7, "a1", { cacheRead: 1000 })]);
    expect(item(out, "fixed", "fixed part (Explore)")?.tokens).toBe(2000);
  });

  test("a sub-agent compaction releases only that sub-agent's parts", () => {
    const rows = [
      req({ id: "m1", at: 1, tokens: { input: 1000 }, tools: [read("t1", "/m.ts")] }),
      side("x1", 3, "a1", { input: 500 }),
      req({ id: "m2", at: 7, tokens: { cacheRead: 1000, input: 1000 } }),
      req({ id: "m3", at: 9, tokens: { cacheRead: 2000 } }),
    ];
    const out = run(rows, [result(2, "t1", 4000)], [{ sessionId: "s", ts: T0 + 8, agentId: "a1" }]);
    // The main-thread Read stays held through the sub-agent's compaction and is re-read by m3.
    expect(near(item(out, "read", "/m.ts")?.rereadUsd ?? -1, 1000 * READ_USD)).toBe(true);
  });

  test("a resumed session's carried conversation is not booked as fixed part", () => {
    const first = (id: string, session: string, prompt: number) => [
      req({ id: `${id}1`, session, at: 1, tokens: { input: prompt } }),
      req({ id: `${id}2`, session, at: 2, tokens: { cacheRead: prompt } }),
    ];
    // Fresh sessions start at 10k, 12k and 16k; the fourth is a trimmed one whose first retained request already holds 80k.
    const out = run([...first("a", "a", 10_000), ...first("b", "b", 12_000), ...first("d", "d", 16_000), ...first("c", "c", 80_000)]);
    // Fixed part is capped at twice the median (14k) of first requests: 28k for the trimmed session.
    expect(item(out, "fixed", "fixed part")?.tokens).toBe(10_000 + 12_000 + 16_000 + 28_000);
    const carried = item(out, "prompt", "carried over");
    expect(carried?.tokens).toBe(52_000);
    expect(near(carried?.rereadUsd ?? -1, 52_000 * READ_USD)).toBe(true);
  });

  test("a lone session keeps all of its first prompt as fixed part", () => {
    const out = run([req({ id: "a", at: 1, tokens: { input: 90_000 } })]);
    expect(item(out, "fixed", "fixed part")?.tokens).toBe(90_000);
    expect(item(out, "prompt", "carried over")).toBeUndefined();
  });

  test("a prompt label is cut on a code point, never through a surrogate pair", () => {
    const text = `${"x".repeat(59)}\u{1F600}tail`;
    const out = run([req({ id: "a", at: 1, tokens: { input: 1000 } })], [prompt(0, 400, text)]);
    expect(out.flow.some((f) => f.label === `${"x".repeat(59)}\u{1F600}`)).toBe(true);
    const cmd = `${"y".repeat(79)}\u{1F600}tail`;
    const b = run([req({ id: "a", at: 1, tokens: { input: 1000 }, tools: [bash("t1", cmd)] })], [result(0, "t1", 400)]);
    expect(b.flow.some((f) => f.label === `${"y".repeat(79)}\u{1F600}`)).toBe(true);
  });
});

describe("pastes", () => {
  test("a prompt of 5000 tokens or more is a paste with its re-read cost", () => {
    expect(PASTE_MIN_TOKENS).toBe(5000);
    const rows = [req({ id: "a", at: 1, tokens: { input: 10_000 } }), req({ id: "b", at: 2, tokens: { cacheRead: 10_000 } }), req({ id: "c", at: 3, tokens: { cacheRead: 10_000 } })];
    const out = run(rows, [prompt(0, 24_000, "big one")]);
    expect(out.pastes.length).toBe(1);
    expect(out.pastes[0].sessionId).toBe("s");
    expect(out.pastes[0].tokens).toBe(6000);
    expect(near(out.pastes[0].rereadUsd, 12_000 * READ_USD)).toBe(true);
  });

  test("a small prompt, a notice or a tool result is not a paste", () => {
    const rows = [req({ id: "a", at: 1, tokens: { input: 30_000 }, tools: [read("t1", "/x")] }), req({ id: "b", at: 2, tokens: { cacheRead: 30_000 } })];
    const out = run(rows, [prompt(0, 4000), notice(0, 40_000), result(2, "t1", 40_000)]);
    expect(out.pastes).toEqual([]);
  });
});

describe("wholeReads", () => {
  const reads = (id: string, at: number, target: string, whole = true, extra: Partial<Parameters<typeof req>[0]> = {}) =>
    req({ id, at, tools: [read(`t-${id}`, target, whole)], ...extra });

  test("the same file read whole three times counts 3; once is left out", () => {
    const out = run([reads("a", 1, "/a.ts"), reads("b", 2, "/a.ts"), reads("c", 3, "/a.ts"), reads("d", 4, "/once.ts"), reads("e", 5, "/twice.ts"), reads("f", 6, "/twice.ts")]);
    expect(out.wholeReads).toEqual({ "/a.ts": 3, "/twice.ts": 2 });
  });

  test("partial reads and uncounted requests do not count", () => {
    const rows = [
      reads("a", 1, "/p.ts", false),
      reads("b", 2, "/p.ts", false),
      reads("c", 3, "/p.ts"),
      reads("e", 5, "/p.ts"),
      reads("f", 6, "/p.ts"),
    ];
    expect(run(rows).wholeReads).toEqual({ "/p.ts": 3 });
    expect(run(rows, [], [], (r) => r.requestId !== "f").wholeReads).toEqual({ "/p.ts": 2 });
  });

  test("a sub-agent transcript is its own conversation", () => {
    const agent = (id: string, at: number, target: string, agentId: string) => reads(id, at, target, true, { sidechain: true, agentId, agentType: "Explore" });
    const rows = [
      agent("a", 1, "/f.ts", "a1"),
      agent("b", 2, "/f.ts", "a1"),
      agent("c", 3, "/f.ts", "a2"),
      reads("d", 4, "/f.ts"),
      agent("e", 5, "/g.ts", "a1"),
      agent("f", 6, "/g.ts", "a2"),
      reads("g", 7, "/g.ts"),
    ];
    // /f.ts twice within a1; /g.ts once in each of three conversations is no repeat.
    expect(run(rows).wholeReads).toEqual({ "/f.ts": 2 });
  });

  test("the count is per session: the most in one conversation", () => {
    const rows = [reads("a", 1, "/s.ts", true, { session: "x" }), reads("b", 2, "/s.ts", true, { session: "x" }), reads("c", 3, "/s.ts", true, { session: "y" })];
    expect(run(rows).wholeReads).toEqual({ "/s.ts": 2 });
  });
});

describe("toolFill and peakContext", () => {
  test("toolFill sums the tokens each tool put into context", () => {
    const rows = [
      req({ id: "a", at: 1, tokens: { input: 1000 }, tools: [read("t1", "/a"), bash("t2", "ls"), read("t3", "/b")] }),
      req({ id: "b", at: 5, tokens: { cacheRead: 1000, input: 3100 } }),
    ];
    const users = [result(2, "t1", 4000), result(3, "t2", 400), result(4, "t3", 8000)];
    expect(run(rows, users).toolFill).toEqual({ Read: 3000, Bash: 100 });
  });

  test("a sub-agent's results count at that sub-agent's own scale", () => {
    const rows = [
      req({ id: "x1", at: 1, agentId: "a1", sidechain: true, tokens: { input: 1000 }, tools: [bash("t1", "pwd")] }),
      req({ id: "x2", at: 3, agentId: "a1", sidechain: true, tokens: { cacheRead: 1000, input: 600 } }),
    ];
    // 4000 chars = 1000 estimated tokens, but the prompt only grew by 600.
    expect(run(rows, [inAgent(result(2, "t1", 4000), "a1")]).toolFill).toEqual({ Bash: 600 });
  });

  test("keys that are also Object.prototype members stay ordinary keys", () => {
    const rows = [
      req({ id: "a", at: 1, session: "constructor", tokens: { input: 1000 }, tools: [{ name: "constructor", id: "t1", inputChars: 1 }, read("t2", "constructor"), read("t3", "constructor")] }),
      req({ id: "b", at: 5, session: "constructor", tokens: { cacheRead: 1000, input: 300 } }),
      req({ id: "c", at: 6, session: "__proto__", tokens: { cacheRead: 7 } }),
    ];
    const out = run(rows, [result(2, "t1", 400, "constructor"), result(3, "t2", 400, "constructor"), result(4, "t3", 400, "constructor")]);
    expect(Object.keys(out.peakContext).sort()).toEqual(["__proto__", "constructor"]);
    expect(out.peakContext.constructor).toBe(1300);
    expect(Object.keys(out.toolFill).sort()).toEqual(["Read", "constructor"]);
    expect(out.toolFill.constructor).toBe(100);
    expect(out.toolFill.Read).toBe(200);
    expect(out.wholeReads).toEqual({ constructor: 2 });
  });

  test("toolFill counts only results a counted request took in", () => {
    const rows = [req({ id: "a", at: 1, tokens: { input: 1000 }, tools: [bash("t1", "ls")] }), req({ id: "b", at: 5, tokens: { cacheRead: 1000, input: 100 } })];
    expect(run(rows, [result(2, "t1", 400)], [], (r) => r.requestId === "a").toolFill).toEqual({});
    expect(run(rows, [result(2, "t1", 400)]).toolFill).toEqual({ Bash: 100 });
  });

  test("peakContext is the largest prompt of any conversation in the session", () => {
    const rows = [
      req({ id: "a", at: 1, tokens: { input: 10, cacheRead: 100, cw5m: 5 } }),
      req({ id: "b", at: 2, tokens: { cacheRead: 300 } }),
      req({ id: "c", at: 3, session: "q", tokens: { cw1h: 50 } }),
      req({ id: "d", at: 4, sidechain: true, tokens: { cacheRead: 9999 } }),
    ];
    expect(run(rows).peakContext).toEqual({ s: 9999, q: 50 });
  });
});

describe("summarize deep dimensions", () => {
  const NOW = T0 + 60 * MIN;
  const withCwd = (rows: UsageRow[], cwd: string) => rows.map((r) => ({ ...r, cwd }));
  const build = (): Shard => {
    const s = story();
    const other = [req({ id: "o1", session: "o", at: 2 * MIN, cwd: "/work/beta", tokens: { input: 500 } }), req({ id: "o2", session: "o", at: 3 * MIN, cwd: "/work/beta", tokens: { cacheRead: 500 } })];
    return {
      v: 1,
      project: "p",
      files: {},
      usage: [...withCwd(s.rows, "/work/alpha"), ...other],
      users: [...s.users, prompt(0, 4 * 500, "other prompt", "o")],
      metas: [],
      compacts: [...s.compacts, { sessionId: "o", ts: T0 + 59 * MIN }, { sessionId: "s", ts: T0 - 5 * 24 * 60 * MIN }],
      snapshots: [],
    };
  };
  const go = (o: Partial<Parameters<typeof summarize>[2]> = {}) => summarize([build()], PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: 0, ...o });

  test("flow prices re-reads at the model's cache-read price", () => {
    const s = go({ repo: "alpha" });
    expect(near(s.flow.find((f) => f.source === "read")?.rereadUsd ?? -1, 1000e-6)).toBe(true);
    expect(s.peakContext).toEqual({ s: 2200 });
  });

  test("compactions are per session and windowed; the repo filter drops other sessions", () => {
    expect(go().compactions).toEqual({ s: 2, o: 1 });
    expect(go({ repo: "alpha" }).compactions).toEqual({ s: 2 });
    expect(go({ span: "24h" }).compactions).toEqual({ s: 1, o: 1 });
    expect(go({ span: "session", sessionId: "o" }).compactions).toEqual({ o: 1 });
  });

  test("an out-of-window request fills the context but adds no cost or tokens of its own", () => {
    const shard: Shard = {
      v: 1,
      project: "p",
      files: {},
      usage: [req({ id: "a", at: -2 * 24 * 60 * MIN, cwd: "/work/alpha", tokens: { input: 1000 } }), req({ id: "b", at: 0, cwd: "/work/alpha", tokens: { cacheRead: 1000 } })],
      users: [],
      metas: [],
      compacts: [],
      snapshots: [],
    };
    const s = summarize([shard], PRICES, { span: "24h", nowMs: T0 + MIN, tzOffsetMin: 0 });
    expect(s.total.requests).toBe(1);
    expect(s.flow.length).toBe(1);
    expect(s.flow[0].tokens).toBe(0);
    expect(near(s.flow[0].rereadUsd, 1000e-6)).toBe(true);
  });

  test("an empty summary has empty deep dimensions", () => {
    const s = summarize([], PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: 0 });
    expect([s.cacheRebuilds, s.flow, s.pastes]).toEqual([[], [], []]);
    expect([s.peakContext, s.wholeReads, s.compactions, s.toolFill]).toEqual([{}, {}, {}, {}]);
  });
});
