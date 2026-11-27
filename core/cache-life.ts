// Cache rebuilds: a large cache write after a pause longer than the cache lives.
import { streamOf } from "./stream.ts";
import { HOUR_MS } from "./time.ts";
import type { UsageRow } from "./types.ts";

export type CacheLife = "5m" | "1h";
export type Rebuild = { sessionId: string; ts: number; tokens: number; usd: number; gapMs: number; ttl: CacheLife };

export const FIVE_MIN_MS = 300_000;
/** A request must write at least this many cache tokens to count as a rebuild. */
export const REBUILD_MIN_WRITE_TOKENS = 20_000;

/**
 * Life of the cache the writes went to, from their actual 5m/1h split. Mixed writes follow the side
 * with more tokens (a tie, or no writes, reads as the shorter 5m).
 */
export function cacheLife(writes: { ts: number; cw5m: number; cw1h: number }[]): CacheLife {
  let m5 = 0;
  let h1 = 0;
  for (const w of writes) {
    m5 += w.cw5m;
    h1 += w.cw1h;
  }
  return h1 > m5 ? "1h" : "5m";
}

/**
 * Rebuilds among `rows` (every non-synthetic request, any order). A request is judged against the one
 * before it in its own stream, counted or not; only counted rebuilds come back, oldest first.
 * `writeUsd` prices a request's cache writes.
 */
export function findRebuilds(rows: UsageRow[], counted: (r: UsageRow) => boolean, writeUsd: (r: UsageRow) => number): Rebuild[] {
  const keyed = rows.map((r) => ({ r, key: streamOf(r) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.r.ts - b.r.ts || (a.r.requestId < b.r.requestId ? -1 : 1)));
  const out: Rebuild[] = [];
  for (let i = 1; i < keyed.length; i++) {
    const { r, key } = keyed[i];
    const before = keyed[i - 1];
    if (before.key !== key) continue;
    const tokens = r.tokens.cw5m + r.tokens.cw1h;
    if (tokens < REBUILD_MIN_WRITE_TOKENS || !counted(r)) continue;
    const gapMs = r.ts - before.r.ts;
    const ttl = cacheLife([{ ts: r.ts, cw5m: r.tokens.cw5m, cw1h: r.tokens.cw1h }]);
    if (gapMs > (ttl === "1h" ? HOUR_MS : FIVE_MIN_MS)) out.push({ sessionId: r.sessionId, ts: r.ts, tokens, usd: writeUsd(r), gapMs, ttl });
  }
  return out.sort((a, b) => a.ts - b.ts || (a.sessionId < b.sessionId ? -1 : 1));
}
