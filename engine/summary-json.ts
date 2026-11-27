import { DAY_MS } from "../core/time.ts";
import { summarize } from "../core/summary.ts";
import type { Money } from "../core/summary.ts";
import type { PriceTable } from "../core/pricing.ts";
import type { Shard } from "../core/shard.ts";
import { loadProject } from "./project-store.ts";
import type { ProgressEnv } from "./progress.ts";

type Tick = () => Promise<void>;

const brief = (m: Money) => ({ usd: m.usd, requests: m.requests, tokens: m.tokens });

/** 30-day Summary as JSON for the accuracy cross-check: total, byModel and byDay (local calendar days). */
export async function summaryJson(
  env: ProgressEnv,
  cfg: string,
  projects: string[],
  nowMs: number,
  tzOffsetMin: number,
  prices: PriceTable,
  tick: Tick = async () => {},
): Promise<string> {
  const shards: Shard[] = [];
  for (const project of projects) {
    await tick();
    const shard = await loadProject(env, cfg, project, nowMs, tick);
    if (shard) shards.push(shard);
  }
  await tick();
  const s = summarize(shards, prices, { span: "30d", nowMs, tzOffsetMin });
  const byModel: Record<string, ReturnType<typeof brief>> = {};
  for (const [k, v] of Object.entries(s.byModel)) byModel[k] = brief(v);
  const byDay = s.timeline.points.map((p, i) => ({
    // `from` is a local midnight, so shifting by the zone offset makes the UTC date read as the local one.
    day: new Date(s.from + i * DAY_MS + tzOffsetMin * 60_000).toISOString().slice(0, 10),
    ...brief(p),
  }));
  return JSON.stringify({ nowMs, tzOffsetMin, from: s.from, to: s.to, total: brief(s.total), byModel, byDay, unpriced: s.unpriced });
}
