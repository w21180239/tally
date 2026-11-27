import { describe, expect, test } from "claude-code/testing";
import { summaryJson } from "../engine/summary-json.ts";
import { idleProgress } from "../engine/progress.ts";
import { saveBuckets, dayIdx } from "../engine/project-store.ts";
import type { Shard } from "../core/shard.ts";
import type { UsageRow } from "../core/types.ts";
import { PRICES, OPUS, NOW, TZ } from "./fixtures/month.ts";
import { worldOf } from "./world.ts";

const DAY = 86_400_000;
const CFG = "/cfg";
const row = (id: string, ts: number, input: number): UsageRow => ({
  requestId: id,
  sessionId: "s1",
  ts,
  model: OPUS,
  tokens: { input, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 },
  fast: false,
  sidechain: false,
  synthetic: false,
  thinkingChars: 0,
  replyChars: 0,
  tools: [],
});
const shard = (project: string, usage: UsageRow[]): Shard => ({ v: 1, project, files: {}, usage, users: [], metas: [], compacts: [], snapshots: [] });

describe("summaryJson", () => {
  test("30d total, byModel and local-day byDay across projects", async () => {
    const w = worldOf();
    // NOW is 2026-11-27T12:30Z = 2026-11-28 01:30 NZDT, so "today" (local) is 2026-11-28.
    const a = NOW - 60 * 60_000; // 11:30Z = 00:30 local 11-28
    const b = NOW - 2 * 60 * 60_000; // 10:30Z = 23:30 local 11-27
    const old = NOW - 40 * DAY;
    await saveBuckets(w.$, CFG, "-p1", { days: new Map([[dayIdx(a), shard("-p1", [row("r1", a, 1_000_000), row("r2", b, 2_000_000)])]]) }, {}, NOW);
    await saveBuckets(w.$, CFG, "-p2", { days: new Map([[dayIdx(old), shard("-p2", [row("r3", old, 5_000_000)])], [dayIdx(a), shard("-p2", [row("r4", a, 3_000_000)])]]) }, {}, NOW);
    let ticks = 0;
    const out = JSON.parse(await summaryJson(w.$, CFG, ["-p1", "-p2", "-none"], NOW, TZ, PRICES, idleProgress(false), async () => void ticks++));
    // opus input is $10 per MTok in the fixture price table.
    expect(Math.abs(out.total.usd - 60) < 1e-9).toBe(true);
    expect(out.total.requests).toBe(3);
    expect(Math.abs(out.byModel[OPUS].usd - 60) < 1e-9).toBe(true);
    expect(out.byDay.length).toBe(30);
    expect(out.byDay[29].day).toBe("2026-11-28");
    expect(out.byDay[28].day).toBe("2026-11-27");
    expect(out.byDay[0].day).toBe("2026-10-30");
    expect(Math.abs(out.byDay[29].usd - 40) < 1e-9).toBe(true);
    expect(Math.abs(out.byDay[28].usd - 20) < 1e-9).toBe(true);
    expect(ticks).toBeGreaterThan(0);
    expect(out.scan.phase).toBe("idle");
    expect(out.unpriced).toEqual([]);
  });
});
