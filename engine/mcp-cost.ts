// MCP schema cost over the index: what each server's resident schemas cost across a span, for the Tokens tab.
import { nearestSnapshot, mcpSchemaSteps } from "../core/breakdown.ts";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import { dict } from "../core/dict.ts";
import type { PriceTable } from "../core/pricing.ts";
import type { Shard } from "../core/shard.ts";
import { drainAsync, STEP_ROWS } from "../core/steps.ts";
import { repoFor } from "../core/summary.ts";
import type { UsageRow } from "../core/types.ts";

/** Schema cost over the main-thread rows of each session, within the span and for the repo ("" is every repo). */
export async function schemaCosts(prices: PriceTable, shards: Shard[], snapsOf: (project: string) => BreakdownSnapshot[], from: number, to: number, repo: string, tick: () => Promise<void>): Promise<{ usd: Record<string, number>; proxy: boolean; missing: number }> {
  const usd = dict<number>();
  let proxy = false;
  let missing = 0;
  for (const shard of shards) {
    const snaps = snapsOf(shard.project);
    const bySession = new Map<string, UsageRow[]>();
    for (let i = 0; i < shard.usage.length; i++) {
      if (i % STEP_ROWS === STEP_ROWS - 1) await tick();
      const r = shard.usage[i]!;
      if (r.synthetic || r.sidechain || r.ts < from || r.ts > to) continue;
      if (repo !== "" && repoFor(r) !== repo) continue;
      const list = bySession.get(r.sessionId);
      if (list === undefined) bySession.set(r.sessionId, [r]);
      else list.push(r);
    }
    for (const [id, rows] of bySession) {
      await tick();
      const near = nearestSnapshot(snaps, rows[0]!.ts, id);
      if (near === null) {
        missing++;
        continue;
      }
      if (near.proxy) proxy = true;
      const part = await drainAsync(mcpSchemaSteps(rows, near.snap, prices), tick);
      for (const [server, n] of Object.entries(part)) usd[server] = (usd[server] ?? 0) + n;
    }
  }
  return { usd, proxy, missing };
}
