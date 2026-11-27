import { describe, test, expect } from "claude-code/testing";
import { cacheLife, findRebuilds, REBUILD_MIN_WRITE_TOKENS } from "../core/cache-life.ts";
import { summarize } from "../core/summary.ts";
import { PRICES } from "./fixtures/month.ts";
import { MIN, T0, req } from "./fixtures/rows.ts";
import type { Shard } from "../core/shard.ts";
import type { UsageRow } from "../core/types.ts";

const w = (cw5m: number, cw1h: number, ts = 0) => ({ ts, cw5m, cw1h });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const find = (rows: UsageRow[], counted: (r: UsageRow) => boolean = () => true) => findRebuilds(rows, counted, (r) => r.tokens.cw5m * 12.5e-6 + r.tokens.cw1h * 20e-6);

describe("cacheLife", () => {
  test("a pure 5m or 1h write names its life", () => {
    expect(cacheLife([w(30_000, 0)])).toBe("5m");
    expect(cacheLife([w(0, 30_000)])).toBe("1h");
  });

  test("mixed write: the side with more tokens wins", () => {
    expect(cacheLife([w(1_000, 30_000)])).toBe("1h");
    expect(cacheLife([w(30_000, 1_000)])).toBe("5m");
  });

  test("tokens add up across writes; no writes means 5m", () => {
    expect(cacheLife([w(10_000, 0), w(0, 6_000), w(0, 6_000)])).toBe("1h");
    expect(cacheLife([])).toBe("5m");
    expect(cacheLife([w(0, 0)])).toBe("5m");
  });
});

describe("findRebuilds", () => {
  test("20k write after a 6 minute gap rebuilds a 5m cache", () => {
    const out = find([req({ id: "a", at: 0, tokens: { cacheRead: 5_000 } }), req({ id: "b", at: 6 * MIN, tokens: { cw5m: 25_000 } })]);
    expect(out.length).toBe(1);
    expect(out[0].sessionId).toBe("s");
    expect(out[0].ts).toBe(T0 + 6 * MIN);
    expect(out[0].tokens).toBe(25_000);
    expect(out[0].gapMs).toBe(6 * MIN);
    expect(out[0].ttl).toBe("5m");
    expect(near(out[0].usd, 25_000 * 12.5e-6)).toBe(true);
  });

  test("the same gap does not rebuild a 1h cache", () => {
    expect(find([req({ id: "a", at: 0 }), req({ id: "b", at: 6 * MIN, tokens: { cw1h: 25_000 } })])).toEqual([]);
  });

  test("a gap past an hour rebuilds a 1h cache", () => {
    const out = find([req({ id: "a", at: 0 }), req({ id: "b", at: 61 * MIN, tokens: { cw1h: 25_000 } })]);
    expect(out.map((r) => r.ttl)).toEqual(["1h"]);
  });

  test("mixed write (1k 5m, 30k 1h) is judged 1h; (30k 5m, 1k 1h) is judged 5m", () => {
    expect(find([req({ id: "a", at: 0 }), req({ id: "b", at: 6 * MIN, tokens: { cw5m: 1_000, cw1h: 30_000 } })])).toEqual([]);
    expect(find([req({ id: "a", at: 0 }), req({ id: "b", at: 6 * MIN, tokens: { cw5m: 30_000, cw1h: 1_000 } })]).map((r) => r.ttl)).toEqual(["5m"]);
  });

  test("below 20k written, at the gap boundary, and first in stream: no rebuild", () => {
    expect(REBUILD_MIN_WRITE_TOKENS).toBe(20_000);
    expect(find([req({ id: "a", at: 0 }), req({ id: "b", at: 6 * MIN, tokens: { cw5m: 19_999 } })])).toEqual([]);
    expect(find([req({ id: "a", at: 0 }), req({ id: "b", at: 5 * MIN, tokens: { cw5m: 25_000 } })])).toEqual([]);
    expect(find([req({ id: "a", at: 0, tokens: { cw5m: 90_000 } })])).toEqual([]);
  });

  test("streams are per session and per sub-agent type; input order does not matter", () => {
    const rows = [
      req({ id: "m2", at: 6 * MIN, tokens: { cw5m: 25_000 } }),
      req({ id: "x1", session: "other", at: 5 * MIN }),
      req({ id: "m1", at: 0 }),
      req({ id: "s1", at: 5 * MIN, sidechain: true, agentType: "Explore" }),
    ];
    // The main stream's gap is 6 minutes; the sub-agent request in between belongs to another stream.
    expect(find(rows).map((r) => r.sessionId)).toEqual(["s"]);
  });

  test("only counted rebuilds are reported, but a gap measured from an uncounted request still stands", () => {
    const rows = [req({ id: "a", at: 0 }), req({ id: "b", at: 6 * MIN, tokens: { cw5m: 25_000 } })];
    expect(find(rows, (r) => r.requestId === "b").length).toBe(1);
    expect(find(rows, (r) => r.requestId === "a")).toEqual([]);
  });
});

describe("summarize cacheRebuilds", () => {
  const shard = (usage: UsageRow[]): Shard => ({ v: 1, project: "p", files: {}, usage, users: [], metas: [], compacts: [], snapshots: [] });
  const NOW = T0 + 10 * 60 * MIN;
  const rows = [
    req({ id: "a", at: 0, cwd: "/work/alpha", tokens: { cacheRead: 1 } }),
    req({ id: "b", at: 6 * MIN, cwd: "/work/alpha", tokens: { cw5m: 25_000 } }),
    req({ id: "c", session: "z", at: 9 * 60 * MIN, cwd: "/work/beta", tokens: { cacheRead: 1 } }),
    req({ id: "d", session: "z", at: 9 * 60 * MIN + 10 * MIN, cwd: "/work/beta", tokens: { cw5m: 30_000 } }),
  ];
  const run = (o: Partial<Parameters<typeof summarize>[2]> = {}) => summarize([shard(rows)], PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: 0, ...o });

  test("rebuilds carry session, size, cost and gap", () => {
    const s = run();
    expect(s.cacheRebuilds.map((r) => [r.sessionId, r.tokens, r.gapMs, r.ttl])).toEqual([["s", 25_000, 6 * MIN, "5m"], ["z", 30_000, 10 * MIN, "5m"]]);
    expect(near(s.cacheRebuilds[0].usd, (25_000 * 12.5) / 1e6)).toBe(true);
  });

  test("repo filter keeps one repo's rebuilds", () => {
    expect(run({ repo: "beta" }).cacheRebuilds.map((r) => r.sessionId)).toEqual(["z"]);
  });

  test("a window that starts between the two requests still sees the gap", () => {
    // 24h window: hourStart(now) - 23h = T0 + 10h - 23h; every row is inside it, so shift now instead.
    const s = run({ span: "24h", nowMs: T0 + 6 * MIN + 30 * MIN });
    expect(s.cacheRebuilds.map((r) => r.sessionId)).toEqual(["s"]);
  });

  test("session span reports that session only", () => {
    expect(run({ span: "session", sessionId: "z" }).cacheRebuilds.map((r) => r.sessionId)).toEqual(["z"]);
  });
});
