import { describe, test, expect } from "claude-code/testing";
import { decodeShard, encodeShard, trimShard, PART_MAX } from "../core/shard.ts";
import type { Shard } from "../core/shard.ts";
import { utf8Length } from "../core/lines.ts";
import { loadShard, projectKey, saveShard } from "../engine/store-index.ts";
import type { UsageRow } from "../core/types.ts";
import { worldOf } from "./world.ts";

const DAY = 86_400_000;
const usage = (i: number, ts = 1_000_000 + i): UsageRow => ({
  requestId: `req-${i}`,
  sessionId: `s-${i % 7}`,
  ts,
  model: "model-a",
  tokens: { input: i, output: 2, cacheRead: 3, cw5m: 4, cw1h: 5 },
  fast: i % 2 === 0,
  sidechain: i % 3 === 0,
  synthetic: i % 5 === 0,
  thinkingChars: 6,
  replyChars: 7,
  tools: i % 4 === 0 ? [{ name: "Bash", command: "ls", inputChars: 2 }] : [],
  ...(i % 2 ? { cwd: "/p/a", skill: "sk" } : { plugin: "pl", effort: "high" }),
});
const shard = (n = 3): Shard => ({
  v: 1,
  project: "demo",
  files: { "/p/a/s-0.jsonl": { size: 10, mtimeMs: 5, offset: 10, isSub: false, sessionId: "s-0" }, "/p/a/s-1.jsonl": { size: 1, mtimeMs: 6, offset: 1, isSub: true, agentType: "x", sessionId: "s-1" } },
  usage: Array.from({ length: n }, (_, i) => usage(i)),
  users: [{ sessionId: "s-0", ts: 1_000_001, kind: "prompt", chars: 4, text: "h\u00e9llo" }],
  metas: [{ sessionId: "s-0", key: "ai-title", value: "T" }],
  compacts: [{ sessionId: "s-0", ts: 1_000_002 }],
  snapshots: [{ ts: 1_000_003, a: [1, 2] }],
});
const CFG = "/cfg";

describe("shard codec", () => {
  test("encode then decode is deep-equal", () => {
    const s = shard(20);
    expect(decodeShard(encodeShard(s))).toEqual(s);
  });
  test("20k usage rows split into parts of at most 3.5 MiB", () => {
    const s = shard(20_000);
    for (const r of s.usage) r.tools = [{ name: "Read", target: "x".repeat(150), inputChars: 150 }];
    const parts = encodeShard(s);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(utf8Length(p)).toBeLessThanOrEqual(PART_MAX);
    expect(decodeShard(parts).usage.length).toBe(20_000);
  });
  test("trim drops rows and files older than the cutoff", () => {
    const s = shard(0);
    s.usage = [usage(1, 100 * DAY), usage(2, 69 * DAY)];
    s.files["/p/a/s-0.jsonl"].mtimeMs = 69 * DAY;
    s.files["/p/a/s-1.jsonl"].mtimeMs = 100 * DAY;
    const t = trimShard(s, 100 * DAY - 30 * DAY);
    expect(t.usage.map((r) => r.requestId)).toEqual(["req-1"]);
    expect(Object.keys(t.files)).toEqual(["/p/a/s-1.jsonl"]);
    expect(t.users).toEqual([]);
    expect(t.metas).toEqual([]);
  });
});

describe("projectKey", () => {
  test("is filesystem-safe, deterministic and collision-resistant", () => {
    const k = projectKey("C:\\Users\\me\\proj:x");
    expect(k).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(projectKey("C:\\Users\\me\\proj:x")).toBe(k);
    expect(projectKey("a/b")).not.toBe(projectKey("a_b"));
  });
});

describe("store index", () => {
  test("save then load round-trips and alternates slots", async () => {
    const w = worldOf();
    await saveShard(w.$, CFG, shard(5));
    await saveShard(w.$, CFG, shard(6));
    expect((await loadShard(w.$, CFG, "demo"))?.usage.length).toBe(6);
    const heads = w.writes.filter((x) => x.path.endsWith("HEAD.json")).map((x) => JSON.parse(x.text).gen);
    expect(heads).toEqual(["A", "B"]);
  });
  test("a crash before HEAD keeps the previous generation", async () => {
    const w = worldOf();
    await saveShard(w.$, CFG, shard(5));
    w.failWriteAt = w.writeCount + 2; // data file ok, HEAD write fails
    await expect(saveShard(w.$, CFG, shard(9))).rejects.toThrow();
    expect((await loadShard(w.$, CFG, "demo"))?.usage.length).toBe(5);
  });
  test("a crash mid data files keeps the previous generation", async () => {
    const w = worldOf();
    const big = shard(20_000);
    for (const r of big.usage) r.tools = [{ name: "Read", target: "x".repeat(150), inputChars: 150 }];
    await saveShard(w.$, CFG, big);
    const next = { ...big, usage: big.usage.slice(0, 15_000) };
    w.failWriteAt = w.writeCount + 2;
    await expect(saveShard(w.$, CFG, next)).rejects.toThrow();
    expect((await loadShard(w.$, CFG, "demo"))?.usage.length).toBe(20_000);
  });
  test("garbage HEAD or a missing part loads as null", async () => {
    const w = worldOf();
    expect(await loadShard(w.$, CFG, "demo")).toBeNull();
    await saveShard(w.$, CFG, shard(3));
    const head = w.writes[w.writes.length - 1].path;
    w.put(head, "{{not json");
    expect(await loadShard(w.$, CFG, "demo")).toBeNull();
    w.put(head, JSON.stringify({ gen: "A", parts: 3 }));
    expect(await loadShard(w.$, CFG, "demo")).toBeNull();
  });
});
