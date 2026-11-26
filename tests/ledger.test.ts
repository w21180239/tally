import { describe, test, expect } from "claude-code/testing";
import { Ledger } from "../core/ledger.ts";
import type { UsageRow } from "../core/types.ts";

const row = (requestId: string, output: number, synthetic = false): UsageRow => ({
  requestId,
  sessionId: "s1",
  ts: 1,
  model: "m",
  tokens: { input: 1, output, cacheRead: 0, cw5m: 0, cw1h: 0 },
  fast: false,
  sidechain: false,
  synthetic,
  thinkingChars: 0,
  replyChars: 0,
  tools: [],
});

describe("ledger", () => {
  test("larger output replaces", () => {
    const l = new Ledger();
    expect(l.offer(row("r", 10), "a", false)).toBe("new");
    expect(l.offer(row("r", 50), "a", false)).toBe("replace");
    expect([...l.rows()].map((r) => r.tokens.output)).toEqual([50]);
  });
  test("later main file is a dup and ownership stays", () => {
    const l = new Ledger();
    l.offer(row("r", 10), "a", false);
    expect(l.offer(row("r", 10), "b", false)).toBe("dup");
    expect(l.owner("r")).toBe("a");
  });
  test("larger output from another main file replaces the row, owner stays", () => {
    const l = new Ledger();
    l.offer(row("r", 10), "a", false);
    expect(l.offer(row("r", 20), "b", false)).toBe("replace");
    expect(l.owner("r")).toBe("a");
  });
  test("subagent file takes ownership from a main file", () => {
    const l = new Ledger();
    l.offer(row("r", 10), "main", false);
    expect(l.offer(row("r", 10), "sub", true)).toBe("replace");
    expect(l.owner("r")).toBe("sub");
    expect([...l.rows()].length).toBe(1);
  });
  test("main file does not take ownership from a subagent", () => {
    const l = new Ledger();
    l.offer(row("r", 10), "sub", true);
    expect(l.offer(row("r", 10), "main", false)).toBe("dup");
    expect(l.owner("r")).toBe("sub");
  });
  test("synthetic rows are registered", () => {
    const l = new Ledger();
    expect(l.offer(row("r", 0, true), "a", false)).toBe("new");
    expect([...l.rows()][0].synthetic).toBe(true);
    expect(l.owner("nope")).toBe(undefined);
  });
  test("rows can be iterated twice", () => {
    const l = new Ledger();
    l.offer(row("r", 10), "a", false);
    const rs = l.rows();
    expect([...rs].length).toBe(1);
    expect([...rs].length).toBe(1);
  });
  test("larger subagent output replaces the row and takes ownership", () => {
    const l = new Ledger();
    l.offer(row("r", 10), "main", false);
    expect(l.offer(row("r", 40), "sub", true)).toBe("replace");
    expect(l.owner("r")).toBe("sub");
    expect([...l.rows()][0].tokens.output).toBe(40);
  });
  test("first subagent keeps ownership over a later subagent", () => {
    const l = new Ledger();
    l.offer(row("r", 10), "sub1", true);
    expect(l.offer(row("r", 10), "sub2", true)).toBe("dup");
    expect(l.offer(row("r", 30), "sub2", true)).toBe("replace");
    expect(l.owner("r")).toBe("sub1");
  });
});
