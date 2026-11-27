import { describe, test, expect } from "claude-code/testing";
import { decodeShard, encodeShard, encodeShardEx, trimShard, INDEX_FORMAT, PART_MAX } from "../core/shard.ts";
import type { Shard } from "../core/shard.ts";
import { utf8Length } from "../core/lines.ts";
import { loadShard, projectKey, saveShard } from "../engine/store-index.ts";
import { joinPath } from "../core/path.ts";
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
  tools: i % 4 === 0 ? [{ name: "Bash", command: "ls", inputChars: 2, id: "toolu_1" }, { name: "Read", target: "/p/a/x", inputChars: 3, whole: true }, { name: "Agent", id: "toolu_2", inputChars: 30, prompt: "Survey the \u00e9 layer" }] : [],
  ...(i % 2 ? { cwd: "/p/a", skill: "sk" } : { plugin: "pl", effort: "high" }),
});
const shard = (n = 3): Shard => ({
  v: 1,
  project: "demo",
  files: { "/p/a/s-0.jsonl": { size: 10, mtimeMs: 5, offset: 10, isSub: false, sessionId: "s-0" }, "/p/a/s-1.jsonl": { size: 1, mtimeMs: 6, offset: 1, isSub: true, agentType: "x", sessionId: "s-1" } },
  usage: Array.from({ length: n }, (_, i) => usage(i)),
  users: [
    { sessionId: "s-0", ts: 1_000_001, kind: "prompt", chars: 4, text: "h\u00e9llo" },
    { sessionId: "s-0", ts: 1_000_002, kind: "toolResult", chars: 9, toolUseId: "t1", results: [{ toolUseId: "t1", chars: 9 }], sidechain: true },
  ],
  metas: [{ sessionId: "s-0", key: "ai-title", value: "T" }],
  compacts: [{ sessionId: "s-0", ts: 1_000_002 }],
  snapshots: [{ sessionId: "s-0", ts: 1_000_003, skills: { "demo-skill": 120 }, mcp: { demo: { tokens: 900, deferred: 100 } }, agents: { helper: 40 }, memory: { "/p/CLAUDE.md": 300 }, system: 3000, tools: 8000 }],
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
    const heads = w.writes.filter((x) => x.path.endsWith("HEAD.json")).map((x) => JSON.parse(x.text).slot);
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
  test("an empty store loads as null; a HEAD naming the wrong part count falls back to probing", async () => {
    const w = worldOf();
    expect(await loadShard(w.$, CFG, "demo")).toBeNull();
    await saveShard(w.$, CFG, shard(3));
    const head = w.writes[w.writes.length - 1].path;
    w.put(head, JSON.stringify({ seq: 1, nonce: "x", slot: "A", parts: 3 }));
    expect((await loadShard(w.$, CFG, "demo"))?.usage.length).toBe(3);
  });
});

const heavy = (n: number, ch: number): Shard => {
  const s = shard(n);
  for (const r of s.usage) r.tools = [{ name: "Read", target: "\u00e9".repeat(ch), inputChars: ch }];
  return s;
};
const dirFor = (project: string) => joinPath(CFG, "tally", "index", projectKey(project));

describe("shard fix round 1", () => {
  test("heavy non-ASCII chunks are halved; an oversize row is dropped and counted", () => {
    const s = heavy(800, 10_000);
    s.usage[10].tools = [{ name: "Read", target: "\u00e9".repeat(2_500_000), inputChars: 1 }];
    const { parts, dropped } = encodeShardEx(s);
    expect(dropped).toBe(1);
    for (const p of parts) expect(utf8Length(p)).toBeLessThanOrEqual(PART_MAX);
    expect(decodeShard(parts).usage.length).toBe(799);
  });
  test("saveShard survives heavy rows and reports the drop", async () => {
    const w = worldOf();
    const s = heavy(600, 10_000);
    s.usage[0].tools = [{ name: "Read", target: "x".repeat(4_000_000), inputChars: 1 }];
    const r = await saveShard(w.$, CFG, s);
    expect(r.dropped).toBe(1);
    expect((await loadShard(w.$, CFG, "demo"))?.usage.length).toBe(599);
  });
  test("a torn or garbage HEAD still loads the newest valid slot", async () => {
    const w = worldOf();
    await saveShard(w.$, CFG, shard(5));
    await saveShard(w.$, CFG, shard(6));
    w.put(joinPath(dirFor("demo"), "HEAD.json"), '{"seq":2,"no');
    expect((await loadShard(w.$, CFG, "demo"))?.usage.length).toBe(6);
    await saveShard(w.$, CFG, shard(7));
    expect((await loadShard(w.$, CFG, "demo"))?.usage.length).toBe(7);
  });
  test("interleaved parts from two saves reject that slot and fall back to the other", async () => {
    const w = worldOf();
    await saveShard(w.$, CFG, shard(5));
    await saveShard(w.$, CFG, shard(6));
    await saveShard(w.$, CFG, heavy(400, 10_000));
    const other = encodeShard(heavy(400, 10_000), { seq: 3, nonce: "other" });
    expect(other.length).toBeGreaterThan(1);
    const dir = dirFor("demo");
    const mine = JSON.parse(w.text(joinPath(dir, "HEAD.json"))!) as { slot: string };
    w.put(joinPath(dir, `${mine.slot}-1.json`), other[1]);
    expect((await loadShard(w.$, CFG, "demo"))?.usage.length).toBe(6);
  });
  test("both slots invalid loads as null", async () => {
    const w = worldOf();
    await saveShard(w.$, CFG, shard(5));
    const dir = dirFor("demo");
    w.put(joinPath(dir, "A-0.json"), "garbage");
    w.put(joinPath(dir, "B-0.json"), "garbage");
    expect(await loadShard(w.$, CFG, "demo")).toBeNull();
  });
  test("a shard stored under another project name is rejected", async () => {
    const w = worldOf();
    await saveShard(w.$, CFG, { ...shard(3), project: "one" });
    const from = dirFor("one");
    const to = dirFor("two");
    for (const f of ["HEAD.json", "A-0.json"]) w.put(joinPath(to, f), w.text(joinPath(from, f))!);
    expect(await loadShard(w.$, CFG, "two")).toBeNull();
  });
  test("trim keeps rows exactly at the cutoff and drops one ms older", () => {
    const s = shard(0);
    s.usage = [usage(1, 5000), usage(2, 4999)];
    s.users = [{ sessionId: "s-0", ts: 5000, kind: "prompt", chars: 1 }, { sessionId: "s-0", ts: 4999, kind: "prompt", chars: 1 }];
    s.compacts = [{ sessionId: "s-0", ts: 5000 }, { sessionId: "s-0", ts: 4999 }];
    s.files["/p/a/s-0.jsonl"].mtimeMs = 5000;
    s.files["/p/a/s-1.jsonl"].mtimeMs = 4999;
    const t = trimShard(s, 5000);
    expect(t.usage.map((r) => r.ts)).toEqual([5000]);
    expect(t.users.map((r) => r.ts)).toEqual([5000]);
    expect(t.compacts.map((r) => r.ts)).toEqual([5000]);
    expect(Object.keys(t.files)).toEqual(["/p/a/s-0.jsonl"]);
  });
});

describe("shard agentType", () => {
  const withTypes = (): Shard => {
    const s = shard(4);
    s.usage[1].agentType = "Explore";
    s.usage[2].agentType = "Plan";
    s.usage[3].agentType = "Explore";
    return s;
  };
  test("round-trips, rows without a type stay without", () => {
    const s = withTypes();
    const d = decodeShard(encodeShard(s));
    expect(d).toEqual(s);
    expect(d.usage.map((r) => r.agentType)).toEqual([undefined, "Explore", "Plan", "Explore"]);
    expect("agentType" in d.usage[0]).toBe(false);
  });
  test("a shard written before the column existed still decodes, agentType absent", () => {
    const s = shard(4);
    const old = encodeShard(s).map((p) => {
      const o = JSON.parse(p) as { items: [string, unknown][] };
      for (const it of o.items) if (it[0] === "usage") (it[1] as unknown[]).length = 20;
      return JSON.stringify(o);
    });
    expect(JSON.parse(old[0]).items.find((i: [string]) => i[0] === "usage")[1].length).toBe(20);
    expect(decodeShard(old)).toEqual(s);
  });
});

describe("shard agentId", () => {
  const withIds = (): Shard => {
    const s = shard(4);
    s.usage[1].agentId = "agent-a1";
    s.usage[2].agentId = "agent-b2";
    s.usage[3].agentId = "agent-a1";
    s.users.push({ sessionId: "s-1", ts: 1_000_004, kind: "prompt", chars: 5, text: "task", sidechain: true, agentId: "agent-a1" });
    s.compacts.push({ sessionId: "s-1", ts: 1_000_005, agentId: "agent-b2" });
    return s;
  };
  test("round-trips on usage, user and compact rows; rows without an id stay without", () => {
    const s = withIds();
    const d = decodeShard(encodeShard(s));
    expect(d).toEqual(s);
    expect(d.usage.map((r) => r.agentId)).toEqual([undefined, "agent-a1", "agent-b2", "agent-a1"]);
    expect("agentId" in d.usage[0]).toBe(false);
    expect("agentId" in d.users[0]).toBe(false);
  });
  test("a shard written before the columns existed still decodes, agentId absent", () => {
    const s = shard(4);
    s.users.push({ sessionId: "s-1", ts: 1_000_004, kind: "prompt", chars: 5, text: "task", sidechain: true });
    const old = encodeShard(withIds()).map((p) => {
      const o = JSON.parse(p) as { items: [string, any][] };
      for (const it of o.items) {
        if (it[0] === "usage") it[1].length = 22;
        if (it[0] === "users") for (const row of it[1].c) row.length = Math.min(row.length, 11);
        if (it[0] === "compacts") for (const c of it[1]) delete c.agentId;
      }
      return JSON.stringify(o);
    });
    const d = decodeShard(old);
    expect(d.usage.map((r) => r.agentId)).toEqual([undefined, undefined, undefined, undefined]);
    expect(d.users.map((r) => r.agentId)).toEqual([undefined, undefined, undefined]);
    expect(d.users[2].sidechain).toBe(true);
  });
});

describe("shard format stamp", () => {
  test("a stamped shard round-trips its format; an unstamped one decodes without it", () => {
    const s: Shard = { ...shard(1), days: { "2026-11-20": 3 }, fmt: INDEX_FORMAT };
    expect(decodeShard(encodeShard(s)).fmt).toBe(INDEX_FORMAT);
    expect("fmt" in decodeShard(encodeShard(shard(1)))).toBe(false);
  });
});
