import { describe, expect, test } from "claude-code/testing";
import { decodeShard, decodeShardAsync, encodeShardAsync, encodeShardEx } from "../core/shard.ts";
import type { Shard } from "../core/shard.ts";
import { createSlicer } from "../engine/slicer.ts";
import { dayIdx, dayKey, loadBuckets, loadProject, saveBuckets } from "../engine/project-store.ts";
import { projectDir } from "../engine/store-index.ts";
import type { UsageRow, UserRow } from "../core/types.ts";
import { worldOf } from "./world.ts";

const DAY = 86_400_000;
const CFG = "/cfg";
const P = "-proj";

const usage = (i: number, ts: number): UsageRow => ({
  requestId: `req-${i}`,
  sessionId: `s-${i % 3}`,
  ts,
  model: "m",
  tokens: { input: i, output: 2, cacheRead: 3, cw5m: 4, cw1h: 5 },
  fast: false,
  sidechain: false,
  synthetic: false,
  thinkingChars: 0,
  replyChars: 0,
  tools: [],
});
const bucket = (rows: UsageRow[], extra: Partial<Shard> = {}): Shard => ({ v: 1, project: P, files: {}, usage: rows, users: [], metas: [], compacts: [], snapshots: [], ...extra });

describe("columnar users, metas and files", () => {
  test("every user-row shape round-trips", () => {
    const users: UserRow[] = [
      { sessionId: "a", ts: 1, kind: "prompt", chars: 9, text: "hello", fileKey: "/p/a.jsonl", offset: 120 },
      { sessionId: "a", ts: 2, kind: "notice", chars: 4 },
      { sessionId: "b", ts: 3, kind: "compaction", chars: 7 },
      { sessionId: "b", ts: 4, kind: "toolResult", chars: 30, toolUseId: "t1", results: [{ toolUseId: "t1", chars: 30 }] },
      { sessionId: "b", ts: 5, kind: "toolResult", chars: 30, toolUseId: "t1", results: [{ toolUseId: "t1", chars: 10 }, { toolUseId: "t2", chars: 20 }] },
      { sessionId: "b", ts: 6, kind: "toolResult", chars: 5, toolUseId: "t9" },
    ];
    const s: Shard = {
      ...bucket([]),
      users,
      metas: [
        { sessionId: "a", key: "ai-title", value: "T" },
        { sessionId: "b", key: "cost-state", value: { startTime: 1, totalCostUSD: 2, modelUsage: { "m-1": { inputTokens: 3, costUSD: 0.5 }, "m-2": { inputTokens: 4, costUSD: 0.25 } }, list: [{ a: 1 }, 2, "x"] } },
      ],
      files: {
        "/p/a/s-1.jsonl": { size: 1, mtimeMs: 2, offset: 1, isSub: false, sessionId: "s-1" },
        "/p/a/other.jsonl": { size: 1, mtimeMs: 2, offset: 1, isSub: false, sessionId: "differs" },
        "C:\\p\\a\\sess\\subagents\\agent-1.jsonl": { size: 5, mtimeMs: 6, offset: 4, isSub: true, agentType: "Explore", sessionId: "sess" },
      },
    };
    const back = decodeShard(encodeShardEx(s).parts);
    expect(back.users).toEqual(users);
    expect(back.metas).toEqual(s.metas);
    expect(back.files).toEqual(s.files);
  });

  test("columnar users are much smaller than the object form", () => {
    const users: UserRow[] = Array.from({ length: 200 }, (_, i) => ({
      sessionId: "11111111-2222-3333-4444-555555555555",
      ts: 1_700_000_000_000 + i,
      kind: "toolResult" as const,
      chars: 10,
      toolUseId: `toolu_${i}`,
      results: [{ toolUseId: `toolu_${i}`, chars: 10 }],
    }));
    const compact = encodeShardEx({ ...bucket([]), users }).parts.join("").length;
    expect(compact).toBeLessThan(JSON.stringify(users).length / 2);
  });
});

describe("cooperative encode and decode", () => {
  const big = (): Shard => bucket(Array.from({ length: 12_000 }, (_, i) => ({ ...usage(i, 5), tools: [{ name: "Read", target: "x".repeat(300), inputChars: 300 }] })));

  test("encode hands control back at least once per part and produces the same bytes", async () => {
    const s = big();
    const sync = encodeShardEx(s, { seq: 1, nonce: "n" });
    expect(sync.parts.length).toBeGreaterThan(1);
    let t = 0;
    let yields = 0;
    const slicer = createSlicer(() => (t += 1), async () => { yields++; }, 0);
    const out = await encodeShardAsync(s, { seq: 1, nonce: "n" }, () => slicer.check());
    expect(out.parts).toEqual(sync.parts);
    expect(yields).toBeGreaterThanOrEqual(sync.parts.length - 1);
  });

  test("decode awaits between parts and matches the sync result", async () => {
    const parts = encodeShardEx(big(), { seq: 1, nonce: "n" }).parts;
    let ticks = 0;
    const back = await decodeShardAsync(parts, async () => { ticks++; });
    expect(ticks).toBe(parts.length);
    expect(back).toEqual(decodeShard(parts));
  });
});

describe("day buckets", () => {
  const T0 = 100 * DAY + 12 * 3_600_000;

  test("save then load round-trips every bucket", async () => {
    const w = worldOf();
    const plan = {
      days: new Map([
        [dayIdx(T0), bucket([usage(1, T0), usage(2, T0 + 5)], { metas: [{ sessionId: "s", key: "ai-title" as const, value: "T" }] })],
        [dayIdx(T0 - DAY), bucket([usage(3, T0 - DAY)])],
      ]),
    };
    const r = await saveBuckets(w.$, CFG, P, plan, {}, T0);
    expect(Object.keys(r.seqs).sort()).toEqual([dayKey(dayIdx(T0 - DAY)), dayKey(dayIdx(T0))]);
    const all = await loadProject(w.$, CFG, P, T0);
    expect(all!.usage.map((u) => u.requestId)).toEqual(["req-3", "req-1", "req-2"]);
    expect(all!.metas.length).toBe(1);
  });

  test("an empty bucket leaves the manifest; days older than the window are not loaded", async () => {
    const w = worldOf();
    const old = dayIdx(T0 - 40 * DAY);
    const r1 = await saveBuckets(w.$, CFG, P, { days: new Map([[old, bucket([usage(1, old * DAY)])], [dayIdx(T0), bucket([usage(2, T0)])]]) }, {}, T0 - 39 * DAY);
    expect(Object.keys(r1.seqs).length).toBe(2);
    const loaded = await loadProject(w.$, CFG, P, T0);
    expect(loaded!.usage.map((u) => u.requestId)).toEqual(["req-2"]);
    const r2 = await saveBuckets(w.$, CFG, P, { days: new Map([[dayIdx(T0), bucket([])]]) }, r1.seqs, T0);
    expect(Object.keys(r2.seqs)).toEqual([]);
  });

  test("a crash between the day-bucket writes and the manifest write reads the committed generation", async () => {
    const w = worldOf();
    const day = dayIdx(T0);
    const r1 = await saveBuckets(w.$, CFG, P, { days: new Map([[day, bucket([usage(1, T0)])]]) }, {}, T0);
    // second save: day part, day HEAD, then the manifest part write fails
    w.failWriteAt = w.writeCount + 3;
    await expect(saveBuckets(w.$, CFG, P, { days: new Map([[day, bucket([usage(1, T0), usage(2, T0)])]]) }, r1.seqs, T0)).rejects.toThrow();
    const l = await loadBuckets(w.$, CFG, P, T0);
    expect(l.kind).toBe("ok");
    expect((await loadProject(w.$, CFG, P, T0))!.usage.map((u) => u.requestId)).toEqual(["req-1"]);
  });

  test("failed saves never overwrite the generation the manifest names", async () => {
    const w = worldOf();
    const day = dayIdx(T0);
    const other = dayIdx(T0 - DAY);
    const r1 = await saveBuckets(w.$, CFG, P, { days: new Map([[day, bucket([usage(1, T0)])], [other, bucket([usage(7, T0 - DAY)])]]) }, {}, T0);
    // two saves of the same bucket die on their manifest write, then a third succeeds
    for (let i = 0; i < 2; i++) {
      w.failWriteAt = w.writeCount + 3;
      await expect(saveBuckets(w.$, CFG, P, { days: new Map([[day, bucket([usage(10 + i, T0)])]]) }, r1.seqs, T0)).rejects.toThrow();
      expect((await loadBuckets(w.$, CFG, P, T0)).kind).toBe("ok");
      expect((await loadProject(w.$, CFG, P, T0))!.usage.map((u) => u.requestId).sort()).toEqual(["req-1", "req-7"]);
    }
    const r2 = await saveBuckets(w.$, CFG, P, { days: new Map([[day, bucket([usage(20, T0)])]]) }, r1.seqs, T0);
    expect((await loadProject(w.$, CFG, P, T0))!.usage.map((u) => u.requestId).sort()).toEqual(["req-20", "req-7"]);
    // the committed generation of the day is still the previous one until the next save lands on top of it
    expect(r2.seqs[dayKey(day)]).toBeGreaterThan(r1.seqs[dayKey(day)]);
  });

  test("when both generations of a bucket are damaged the project reads as corrupt, never mixed", async () => {
    const w = worldOf();
    const day = dayIdx(T0);
    await saveBuckets(w.$, CFG, P, { days: new Map([[day, bucket([usage(1, T0)])]]) }, {}, T0);
    const dir = `${projectDir(CFG, P)}/d-${dayKey(day)}`;
    w.put(`${dir}/A-0.json`, "garbage");
    w.put(`${dir}/B-0.json`, "garbage");
    expect((await loadBuckets(w.$, CFG, P, T0)).kind).toBe("corrupt");
    expect(await loadProject(w.$, CFG, P, T0)).toBeNull();
  });

  test("no manifest reads as empty", async () => {
    const w = worldOf();
    expect((await loadBuckets(w.$, CFG, P, T0)).kind).toBe("empty");
    w.put(`${projectDir(CFG, P)}/HEAD.json`, "{}");
    expect((await loadBuckets(w.$, CFG, P, T0)).kind).toBe("empty");
  });
});
