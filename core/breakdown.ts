// The context's makeup as the engine's /context breakdown reports it, kept as snapshots, and what an MCP
// server's schemas cost to keep in the window. Pure.
import { dict } from "./dict.ts";
import { cacheUnitPrices, memoResolver } from "./pricing.ts";
import type { PriceTable } from "./pricing.ts";
import { STEP_ROWS } from "./steps.ts";
import type { Steps } from "./steps.ts";
import type { FlowItem } from "./flow.ts";
import type { UsageRow } from "./types.ts";

export type BreakdownSnapshot = {
  sessionId: string;
  ts: number;
  /** Skill name to the tokens of its listing. */
  skills: Record<string, number>;
  /** MCP server (the segment of the wire name) to its schema tokens and the part of them left out of the window until searched for. */
  mcp: Record<string, { tokens: number; deferred: number }>;
  /** Custom agent type to the tokens of its description. */
  agents: Record<string, number>;
  /** Memory file path to its tokens. */
  memory: Record<string, number>;
  system: number;
  tools: number;
};

/** The parts of the engine's breakdown a snapshot reads. */
export type BreakdownInput = {
  categories?: Array<{ name: string; tokens: number; kind?: string }>;
  mcpTools?: Array<{ name: string; serverName: string; tokens: number; isLoaded: boolean }>;
  agents?: Array<{ agentType: string; tokens: number }>;
  memoryFiles?: Array<{ path: string; tokens: number }>;
  skills?: { skillFrontmatter: Array<{ name: string; tokens: number }> };
};

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/** The server a wire tool name `mcp__<server>__<tool>` belongs to; null for any other name. */
export function mcpServerOf(tool: string): string | null {
  if (!tool.startsWith("mcp__")) return null;
  return tool.split("__")[1] || null;
}

// The two fixed rows: the engine names them, and no kind tells them from other used rows.
const categoryTokens = (b: BreakdownInput, name: RegExp): number => {
  let n = 0;
  for (const c of b.categories ?? []) if (c.kind !== "deferred" && name.test(c.name)) n += count(c.tokens);
  return n;
};

/** A snapshot of `b` for `sessionId` at `ts`. */
export function snapshotOf(sessionId: string, ts: number, b: BreakdownInput): BreakdownSnapshot {
  const skills = dict<number>();
  for (const s of b.skills?.skillFrontmatter ?? []) skills[s.name] = (skills[s.name] ?? 0) + count(s.tokens);
  const mcp = dict<{ tokens: number; deferred: number }>();
  for (const t of b.mcpTools ?? []) {
    const server = mcpServerOf(t.name) ?? t.serverName;
    const cur = (mcp[server] ??= { tokens: 0, deferred: 0 });
    cur.tokens += count(t.tokens);
    if (!t.isLoaded) cur.deferred += count(t.tokens);
  }
  const agents = dict<number>();
  for (const a of b.agents ?? []) agents[a.agentType] = (agents[a.agentType] ?? 0) + count(a.tokens);
  const memory = dict<number>();
  for (const m of b.memoryFiles ?? []) memory[m.path] = (memory[m.path] ?? 0) + count(m.tokens);
  return { sessionId, ts, skills, mcp, agents, memory, system: categoryTokens(b, /^system prompt/i), tools: categoryTokens(b, /^system tools/i) };
}

/**
 * The snapshot nearest `ts` in time (the earlier one on a tie), and whether it only stands in for the real
 * thing: `proxy` is false when it was taken in `sessionId`, true for any other. Null with no snapshots.
 */
export function nearestSnapshot(snaps: BreakdownSnapshot[], ts: number, sessionId?: string): { snap: BreakdownSnapshot; proxy: boolean } | null {
  let best: BreakdownSnapshot | null = null;
  for (const s of snaps) {
    if (best === null) {
      best = s;
      continue;
    }
    const d = Math.abs(s.ts - ts);
    const bd = Math.abs(best.ts - ts);
    if (d < bd || (d === bd && s.ts < best.ts)) best = s;
  }
  if (best === null) return null;
  // A session's own snapshot is the one to trust over any nearer one from another session.
  const own = sessionId === undefined ? undefined : snaps.filter((s) => s.sessionId === sessionId);
  if (own !== undefined && own.length > 0) {
    let o = own[0]!;
    for (const s of own) if (Math.abs(s.ts - ts) < Math.abs(o.ts - ts)) o = s;
    return { snap: o, proxy: false };
  }
  return { snap: best, proxy: true };
}

/** Schema tokens each server keeps in the window: all of them, less the deferred part. */
export function residentTokens(snap: BreakdownSnapshot): Record<string, number> {
  const out = dict<number>();
  for (const [server, m] of Object.entries(snap.mcp)) {
    const n = Math.max(0, m.tokens - m.deferred);
    if (n > 0) out[server] = n;
  }
  return out;
}

/**
 * What each server's resident schemas cost over `rows`: their tokens times the cache-read price of every main-thread
 * request, since each one re-read them. A sub-agent has a tool list of its own and is left out.
 */
export function* mcpSchemaSteps(rows: UsageRow[], snap: BreakdownSnapshot, prices: PriceTable): Steps<Record<string, number>> {
  const resident = Object.entries(residentTokens(snap));
  const out = dict<number>();
  if (resident.length === 0) return out;
  const resolve = memoResolver(prices);
  for (let i = 0; i < rows.length; i++) {
    if (i % STEP_ROWS === STEP_ROWS - 1) yield;
    const r = rows[i]!;
    if (r.synthetic || r.sidechain) continue;
    const read = cacheUnitPrices(r, prices, resolve).read;
    if (read === 0) continue;
    for (const [server, tokens] of resident) out[server] = (out[server] ?? 0) + tokens * read;
  }
  return out;
}

/** What re-reading each server's tool results cost, from the context flow's parts. */
export function mcpResultUsd(flow: FlowItem[]): Record<string, number> {
  const out = dict<number>();
  for (const f of flow) {
    if (f.source !== "mcp") continue;
    const server = mcpServerOf(f.label);
    if (server !== null) out[server] = (out[server] ?? 0) + f.rereadUsd;
  }
  return out;
}
