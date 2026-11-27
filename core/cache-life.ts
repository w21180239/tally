// Cache rebuilds: a large cache write after a pause longer than the cache lives.
import { streamOf } from "./stream.ts";
import { HOUR_MS } from "./time.ts";
import type { UsageRow } from "./types.ts";
import { drain, STEP_ROWS } from "./steps.ts";
import type { Steps } from "./steps.ts";

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
  return drain(findRebuildsSteps(rows, counted, writeUsd));
}

/** `findRebuilds` in steps: rows are grouped by stream and each stream is sorted alone, so no single sort spans every row. */
export function* findRebuildsSteps(rows: UsageRow[], counted: (r: UsageRow) => boolean, writeUsd: (r: UsageRow) => number): Steps<Rebuild[]> {
  const streams = new Map<string, UsageRow[]>();
  for (let i = 0; i < rows.length; i++) {
    if (i % STEP_ROWS === STEP_ROWS - 1) yield;
    const key = streamOf(rows[i]);
    const g = streams.get(key);
    if (g) g.push(rows[i]);
    else streams.set(key, [rows[i]]);
  }
  const out: Rebuild[] = [];
  let n = 0;
  for (const key of [...streams.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const group = streams.get(key)!;
    group.sort((a, b) => a.ts - b.ts || (a.requestId < b.requestId ? -1 : 1));
    n += group.length;
    if (n >= STEP_ROWS) {
      n = 0;
      yield;
    }
    for (let i = 1; i < group.length; i++) {
      const r = group[i];
      const tokens = r.tokens.cw5m + r.tokens.cw1h;
      if (tokens < REBUILD_MIN_WRITE_TOKENS || !counted(r)) continue;
      const gapMs = r.ts - group[i - 1].ts;
      const ttl = cacheLife([{ ts: r.ts, cw5m: r.tokens.cw5m, cw1h: r.tokens.cw1h }]);
      if (gapMs > (ttl === "1h" ? HOUR_MS : FIVE_MIN_MS)) out.push({ sessionId: r.sessionId, ts: r.ts, tokens, usd: writeUsd(r), gapMs, ttl });
    }
  }
  return out.sort((a, b) => a.ts - b.ts || (a.sessionId < b.sessionId ? -1 : 1));
}

/**
 * What the main threads' pauses would have cost under each cache life. `usd5m` and `usd1h` price the cache
 * traffic only (reads and writes) of every counted request after the first of its stream; `pauses` sorts those
 * requests by the gap before them: up to 5 minutes, up to an hour, longer. `actual` is the life the writes used.
 */
export type TtlModel = { requests: number; actual: CacheLife; usd5m: number; usd1h: number; pauses: { short: number; mid: number; long: number } };

const isMain = (r: UsageRow): boolean => !r.sidechain && r.agentId === undefined;
const cached = (t: UsageRow["tokens"]): number => t.cacheRead + t.cw5m + t.cw1h;

/**
 * Replays each main thread's requests under a 5-minute and under a 1-hour cache. A request keeps its cached
 * prefix when the pause since the stream's previous request is within the life: it reads all of the prompt but
 * the part that grew since then (growth, written at the life's price). After a longer pause it writes the whole
 * cached prompt again. A prompt that shrank (a compaction) writes all of itself. `unit` prices a request's cache
 * tokens per token; sub-agent rows are left out, and so are the first request of a stream and requests `counted`
 * rejects (those still set the pause of the next one). Yields every STEP_ROWS rows.
 */
export function* ttlModelSteps(rows: UsageRow[], counted: (r: UsageRow) => boolean, unit: (r: UsageRow) => { read: number; cw5m: number; cw1h: number }): Steps<TtlModel> {
  const streams = new Map<string, UsageRow[]>();
  let n = 0;
  for (const r of rows) {
    if (++n % STEP_ROWS === 0) yield;
    if (!isMain(r)) continue;
    const key = streamOf(r);
    const g = streams.get(key);
    if (g) g.push(r);
    else streams.set(key, [r]);
  }
  const out: TtlModel = { requests: 0, actual: "5m", usd5m: 0, usd1h: 0, pauses: { short: 0, mid: 0, long: 0 } };
  const writes: { ts: number; cw5m: number; cw1h: number }[] = [];
  for (const group of streams.values()) {
    group.sort((a, b) => a.ts - b.ts || (a.requestId < b.requestId ? -1 : 1));
    n += group.length;
    if (n >= STEP_ROWS) {
      n = 0;
      yield;
    }
    for (let i = 0; i < group.length; i++) {
      const r = group[i]!;
      if (!counted(r)) continue;
      writes.push({ ts: r.ts, cw5m: r.tokens.cw5m, cw1h: r.tokens.cw1h });
      if (i === 0) continue;
      const total = cached(r.tokens);
      const before = cached(group[i - 1]!.tokens);
      const grew = total >= before ? total - before : total;
      const gap = r.ts - group[i - 1]!.ts;
      const u = unit(r);
      const priced = (life: number, write: number): number => (gap <= life ? (total - grew) * u.read + grew * write : total * write);
      out.requests++;
      out.usd5m += priced(FIVE_MIN_MS, u.cw5m);
      out.usd1h += priced(HOUR_MS, u.cw1h);
      out.pauses[gap <= FIVE_MIN_MS ? "short" : gap <= HOUR_MS ? "mid" : "long"]++;
    }
  }
  out.actual = cacheLife(writes);
  return out;
}
