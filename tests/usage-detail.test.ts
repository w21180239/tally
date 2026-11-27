import { describe, expect, test } from "claude-code/testing";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import type { Shard } from "../core/shard.ts";
import { summarize } from "../core/summary.ts";
import type { Summary } from "../core/summary.ts";
import type { ToolUse } from "../core/types.ts";
import { usageAgents, usageDetail, usageText, usageTotals, writeParts } from "../core/usage-detail.ts";
import { PRICES } from "./fixtures/month.ts";
import { bash, inAgent, MIN, notice, prompt, req, result, summary as recap, T0 } from "./fixtures/rows.ts";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const close = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-6;
const NOW = T0 + 60 * MIN;
const write = (id: string, target: string, chars: number): ToolUse => ({ name: "Write", id, target, inputChars: chars });

const shardOf = (usage: Shard["usage"], users: Shard["users"] = [], compacts: Shard["compacts"] = []): Shard => ({ v: 1, project: "p", files: {}, usage, users, metas: [], compacts, snapshots: [] });
const run = (sh: Shard, o: Partial<Parameters<typeof summarize>[2]> = {}): Summary => summarize([sh], PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: 0, usage: true, ...o });
const row = (rows: ReturnType<typeof usageDetail>, label: string) => rows.find((r) => r.label === label);

// Prices here: opus input 10, output 50, cache read 1, 5m write 12.5 (USD per MTok).
describe("usage detail: cache write causes", () => {
  // A story with one write of each cause: first, a tool result, a long pause, a compaction.
  const story = () =>
    shardOf(
      [
        req({ id: "a", at: 0, tokens: { cw5m: 20_000, output: 100 } }),
        req({ id: "b", at: MIN, tokens: { cacheRead: 20_000, cw5m: 5000 }, tools: [bash("tb", "make test")] }),
        req({ id: "c", at: 20 * MIN, tokens: { cacheRead: 25_000, cw5m: 30_000 } }),
        req({ id: "d", at: 26 * MIN, tokens: { cw5m: 8000 } }),
      ],
      [prompt(0, 400, "build it"), result(MIN - 1000, "tb", 20_000), prompt(20 * MIN, 40, "later")],
      [{ sessionId: "s", ts: T0 + 25 * MIN }],
    );

  test("the first request is first, one after compacting is compaction, one after more than the cache lives is pause", () => {
    const big = run(story()).usage!.slices.main!.big;
    const why = Object.fromEntries(big.map((b) => [b.ts - T0, b.why]));
    expect(why).toEqual({ 0: "first", [20 * MIN]: "pause", [26 * MIN]: "compaction", [MIN]: "tool" });
    expect(big.map((b) => b.tokens)).toEqual([30_000, 20_000, 8000, 5000]);
    expect(big.find((b) => b.why === "pause")?.pauseMs).toBe(19 * MIN);
  });

  test("a pause counts against the cache's own life: an hour-long cache is not rebuilt by a ten-minute gap", () => {
    const sh = shardOf([req({ id: "a", at: 0, tokens: { cw1h: 20_000 } }), req({ id: "b", at: 10 * MIN, tokens: { cacheRead: 20_000, cw1h: 30_000 } })], [prompt(10 * MIN - 1, 400, "again")]);
    expect(run(sh).usage!.slices.main!.big.map((b) => b.why)).toEqual(["prompt", "first"]);
  });

  test("the tool cause names the tool and what it ran on; the row carries it in full", () => {
    const rows = writeParts(run(story()), undefined).largest;
    const tool = rows.find((r) => r.full?.startsWith("Bash"));
    expect(tool?.full).toBe("Bash make test");
    expect(tool?.label).toContain("tool output: Bash make test");
    expect(rows[0]!.label).toMatch(/^11-20 00:20 \u{b7} cache lapsed after a 19m pause$/u);
    expect(rows.find((r) => r.tokens === 20_000)?.label).toContain("first request");
    expect(rows.find((r) => r.tokens === 8000)?.label).toContain("after compacting");
  });

  test("groups are exact: agent, model and how many writes, priced at the write rate", () => {
    const rows = usageDetail(run(story()), "cacheWrite");
    const g = rows[0]!;
    expect(g.label).toBe("Main conversation \u{b7} opus-5-5 \u{b7} 4 writes");
    expect(g.tokens).toBe(63_000);
    expect(near(g.usd, 63_000 * 12.5e-6)).toBe(true);
    expect(g.estimated).toBe(false);
  });

  test("a write with no new text in front of it is the previous reply", () => {
    const sh = shardOf([req({ id: "a", at: 0, tokens: { cw5m: 1000 } }), req({ id: "b", at: MIN, tokens: { cacheRead: 1000, cw5m: 500 } })], [prompt(0, 40, "hi")]);
    expect(run(sh).usage!.slices.main!.big.find((b) => b.ts === T0 + MIN)?.why).toBe("reply");
  });

  test("sub-agents have their own writes and the agent filter narrows to one", () => {
    const sh = shardOf([req({ id: "a", at: 0, tokens: { cw5m: 1000 } }), { ...inAgent(req({ id: "x", at: MIN, tokens: { cw5m: 4000 }, agentType: "Explore" }), "ag1") }], [prompt(0, 40, "hi")]);
    const s = run(sh);
    expect(usageAgents(s).map((a) => a.key)).toEqual(["main", "sub:Explore"]);
    expect(usageDetail(s, "cacheWrite", "sub:Explore")[0]).toMatchObject({ label: "Explore \u{b7} opus-5-5 \u{b7} 1 write", tokens: 4000 });
    expect(usageTotals(s, "cacheWrite", "main").tokens).toBe(1000);
    expect(usageTotals(s, "cacheWrite").tokens).toBe(5000);
  });
});

describe("usage detail: input and output", () => {
  test("uncached input is shared among the parts that arrived with the request, by size", () => {
    const sh = shardOf([req({ id: "a", at: 0, tokens: { input: 1000 } })], [prompt(0, 3000, "go"), { ...result(0, "t0", 1000), ts: T0 }, notice(0, 0)]);
    const s = run(sh);
    const rows = usageDetail(s, "input");
    expect(close(row(rows, "Typed messages")?.tokens, 750)).toBe(true);
    expect(row(rows, "Tool output")).toBeUndefined();
    expect(close(row(rows, "Other tool output")?.tokens, 250)).toBe(true);
    expect(rows.every((r) => r.estimated)).toBe(true);
    expect(near(usageTotals(s, "input").usd, 1000 * 10e-6)).toBe(true);
  });

  test("with nothing arriving, a first request's input is startup context and a later one's is a typed message", () => {
    const sh = shardOf([req({ id: "a", at: 0, tokens: { input: 100 } }), req({ id: "b", at: MIN, tokens: { input: 50, cacheRead: 100 } })]);
    const rows = usageDetail(run(sh), "input");
    expect(rows.map((r) => [r.label, r.tokens])).toEqual([["Startup context", 100], ["Typed messages", 50]]);
  });

  test("output is thinking by remainder, then replies, writes, commands and agent briefs by size", () => {
    const sh = shardOf([
      {
        ...req({ id: "a", at: 0, tokens: { output: 1000 }, tools: [bash("t1", "ls -la /tmp"), write("t2", "/src/a.ts", 800), { name: "Agent", id: "t3", inputChars: 200 }, { name: "Grep", id: "t4", inputChars: 40 }] }),
        replyChars: 400,
      },
    ]);
    const s = run(sh);
    const rows = usageDetail(s, "output");
    const tokens = (label: string) => row(rows, label)?.tokens ?? -1;
    // replies 100, commands 2.5 (the Bash input), writes 200, agent 50, other 10: 362.5 visible, 637.5 thinking.
    expect(close(tokens("Reply text"), 100)).toBe(true);
    expect(close(tokens("File writes and edits"), 200)).toBe(true);
    expect(close(tokens("Sub-agent briefs"), 50)).toBe(true);
    expect(close(tokens("Thinking"), 637.5)).toBe(true);
    expect(close(rows.reduce((n, r) => n + (r.label.startsWith(" ") ? 0 : r.tokens), 0), 1000)).toBe(true);
    expect(row(rows, "  /src/a.ts")?.full).toBeUndefined();
    expect(near(usageTotals(s, "output").usd, 1000 * 50e-6)).toBe(true);
  });

  test("a command lists under Shell commands with its whole text behind it; a long one is cut in the label", () => {
    const long = `echo ${"x".repeat(200)}`;
    const sh = shardOf([req({ id: "a", at: 0, tokens: { output: 500 }, tools: [{ ...bash("t1", long), inputChars: 400 }] })]);
    const rows = usageDetail(run(sh), "output");
    const item = rows.find((r) => r.label.startsWith("  echo"));
    expect(item?.full).toBe(long);
    expect(item!.label.length).toBeLessThan(80);
    expect(item!.label.endsWith("\u{2026}")).toBe(true);
  });

  test("written parts larger than the reported output are scaled down to it", () => {
    const sh = shardOf([{ ...req({ id: "a", at: 0, tokens: { output: 100 } }), replyChars: 4000 }]);
    const rows = usageDetail(run(sh), "output");
    expect(rows.map((r) => [r.label, Math.round(r.tokens)])).toEqual([["Reply text", 100]]);
  });

  test("the kinds' dollars add up to the summary's total", () => {
    const sh = shardOf([req({ id: "a", at: 0, tokens: { input: 1000, output: 500, cacheRead: 20_000, cw5m: 5000, cw1h: 2000 } })], [prompt(0, 400, "x")]);
    const s = run(sh);
    const all = (["input", "output", "cacheRead", "cacheWrite"] as const).reduce((n, k) => n + usageTotals(s, k).usd, 0);
    expect(near(all, s.total.usd)).toBe(true);
  });
});

describe("usage detail: cache read", () => {
  const story = () =>
    shardOf(
      [req({ id: "a", at: 0, tokens: { cw5m: 12_000 } }), req({ id: "b", at: MIN, tokens: { cacheRead: 12_000, cw5m: 2000 }, tools: [{ name: "Read", id: "r1", target: "/src/a.ts", inputChars: 20, whole: true }] }), req({ id: "c", at: 2 * MIN, tokens: { cacheRead: 14_000 } })],
      [prompt(0, 2000, "hello"), result(MIN - 1, "r1", 8000)],
    );
  const SNAP: BreakdownSnapshot = { sessionId: "s", ts: T0, skills: { brainstorm: 500 }, mcp: { demo: { tokens: 1500, deferred: 500 } }, agents: {}, memory: { "/m/CLAUDE.md": 1000 }, system: 3000, tools: 4000 };

  test("the context's parts come back by source with their re-read tokens and cost", () => {
    const s = run(story());
    const rows = usageDetail(s, "cacheRead");
    const fixed = row(rows, "Startup context")!;
    const reads = row(rows, "File reads")!;
    expect(fixed.tokens).toBeGreaterThan(0);
    expect(close(reads.tokens, 2000 * 1)).toBe(true);
    expect(near(reads.usd, 2000 * 1e-6)).toBe(true);
    expect(close(row(rows, "  /src/a.ts")?.tokens, 2000)).toBe(true);
    expect(rows.every((r) => r.estimated)).toBe(true);
    expect(usageTotals(s, "cacheRead").tokens).toBe(26_000);
  });

  test("the fixed part splits by the context breakdown, its pieces adding up to the part", () => {
    const s = run(story());
    const plain = usageDetail(s, "cacheRead");
    const split = usageDetail(s, "cacheRead", undefined, { snap: SNAP });
    const whole = row(split, "Startup context")!;
    const at = split.indexOf(whole);
    const pieces: typeof split = [];
    for (let i = at + 1; i < split.length && split[i]!.label.startsWith("  "); i++) pieces.push(split[i]!);
    expect(pieces.map((p) => p.label.trim()).sort()).toEqual(["Base instructions", "Built-in tool schemas", "MCP server schemas", "Memory notes", "Other startup context", "Skill listing"].sort());
    expect(close(pieces.reduce((n, p) => n + p.usd, 0), whole.usd)).toBe(true);
    expect(close(pieces.reduce((n, p) => n + p.tokens, 0), whole.tokens)).toBe(true);
    // Without a breakdown the part stays whole, listed as the main thread's own.
    expect(close(plain.find((r) => r.label === "  Main startup")?.usd, whole.usd)).toBe(true);
  });

  test("a sub-agent's fixed part is not split by the main thread's breakdown", () => {
    const sh = shardOf([req({ id: "a", at: 0, tokens: { cw5m: 3000 } }), { ...inAgent(req({ id: "x", at: 0, tokens: { cw5m: 4000 }, agentType: "Explore" }), "ag1") }, { ...inAgent(req({ id: "y", at: MIN, tokens: { cacheRead: 4000 }, agentType: "Explore" }), "ag1") }]);
    const rows = usageDetail(run(sh), "cacheRead", "sub:Explore", { snap: SNAP });
    expect(rows.map((r) => r.label)).toEqual(["Startup context", "  Explore startup"]);
  });

  test("the agent filter reads that agent's parts alone", () => {
    const sh = shardOf([req({ id: "a", at: 0, tokens: { cw5m: 3000 } }), req({ id: "b", at: MIN, tokens: { cacheRead: 3000 } }), { ...inAgent(req({ id: "x", at: 0, tokens: { cw5m: 4000 }, agentType: "Explore" }), "ag1") }, { ...inAgent(req({ id: "y", at: MIN, tokens: { cacheRead: 4000 }, agentType: "Explore" }), "ag1") }]);
    const s = run(sh);
    expect(usageDetail(s, "cacheRead", "main")[0]).toMatchObject({ label: "Startup context", tokens: 3000 });
    expect(usageDetail(s, "cacheRead", "sub:Explore")[0]).toMatchObject({ tokens: 4000 });
    expect(usageDetail(s, "cacheRead")[0]!.tokens).toBe(7000);
  });

  test("a compaction summary and a resumed conversation are their own groups", () => {
    const sh = shardOf([req({ id: "a", at: 0, tokens: { cw5m: 10_000 } }), req({ id: "b", at: MIN, tokens: { cacheRead: 10_000 } }), req({ id: "c", at: 3 * MIN, tokens: { cw5m: 6000 } }), req({ id: "d", at: 4 * MIN, tokens: { cacheRead: 6000 } })], [prompt(0, 400, "x"), recap(2 * MIN, 8000)], [{ sessionId: "s", ts: T0 + 2 * MIN }]);
    const rows = usageDetail(run(sh), "cacheRead");
    expect(row(rows, "Compaction recap")?.tokens).toBeGreaterThan(0);
  });
});

describe("usage detail: other", () => {
  test("without the usage option the summary carries no detail and the rows are empty but for cache read", () => {
    const s = summarize([shardOf([req({ id: "a", at: 0, tokens: { cw5m: 100 } })])], PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: 0 });
    expect(s.usage).toBeUndefined();
    expect(usageDetail(s, "input")).toEqual([]);
    expect(usageDetail(s, "cacheWrite")).toEqual([]);
  });

  test("the usage pass gives the same summary as without it, and sync and async agree", async () => {
    const sh = shardOf([req({ id: "a", at: 0, tokens: { cw5m: 1000, output: 10 } })], [prompt(0, 40, "hi")]);
    const { usage, ...withIt } = run(sh);
    expect(usage).toBeDefined();
    expect(withIt).toEqual(summarize([sh], PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: 0 }));
  });

  test("the text for the clipboard opens with the head, then the column head, then each section", () => {
    const out = usageText("Usage \u{b7} 30 days", [{ title: "Input", total: { tokens: 1500, usd: 0.5 }, rows: [{ label: "Typed messages", tokens: 1000, usd: 0.3, estimated: true }, { label: "Shell output", tokens: 500, usd: 0.2, estimated: false }] }], { tokens: (n) => `${n}`, money: (u) => u.toFixed(2) });
    const lines = out.split("\n");
    expect(lines[0]).toBe("Usage \u{b7} 30 days");
    expect(lines[1]).toMatch(/^what\s+tokens\s+cost$/);
    expect(lines[3]).toMatch(/^Input\s+1500\s+0\.50$/);
    expect(lines[4]).toMatch(/^Typed messages\s+~1000\s+~0\.30$/);
    expect(lines[5]).toMatch(/^Shell output\s+500\s+0\.20$/);
  });
});
