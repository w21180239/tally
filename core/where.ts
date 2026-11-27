// What the session's money was spent on, as plain rows: who spent it, on which model, on which kind of token,
// and how long each conversation's cache has left. Pure.
import type { LiveState } from "./live-state.ts";
import { stepRow, NOISE_USD } from "./live-state.ts";
import { costOf, resolvePrice } from "./pricing.ts";
import type { PriceTable } from "./pricing.ts";
import type { Tokens } from "./types.ts";

/** `kind`: the main thread, a sub-agent of this launch, an earlier launch's sub-agents, the ledger's side requests, or the sum of dropped sub-agents. */
export type WentRow = { label: string; model: string; usd: number; kind: "main" | "agent" | "earlier" | "side" | "rest" };

const byUsd = (a: WentRow, b: WentRow): number => b.usd - a.usd || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
const LABEL_CUT = 32;
const cut = (s: string): string => (s.length > LABEL_CUT ? `${s.slice(0, LABEL_CUT - 1)}\u{2026}` : s);

/** The session's whole spend: earlier launches, this launch's tallied requests, and what only the ledger shows. */
export function totalUsd(live: LiveState): number {
  let usd = live.restoredUsd + live.other.usd;
  for (const m of Object.values(live.stepped)) usd += m.usd;
  return usd;
}

/** The model that cost the most in a by-model record; "" for none. */
export function topModel(costs: Record<string, number>): string {
  let best = "";
  let top = 0;
  for (const [m, usd] of Object.entries(costs)) if (usd > top) ((best = m), (top = usd));
  return best;
}

/**
 * Spend by stream, summing to `totalUsd`: main (all launches), each live sub-agent, earlier launches' sub-agents by
 * type, and the ledger's side requests by model. A sub-agent evicted from the capped map returns as one row.
 */
export function whereItWent(live: LiveState): WentRow[] {
  const rows: WentRow[] = [];
  const earlierSub = Object.values(live.restoredSub).reduce((a, b) => a + b, 0);
  const mainUsd = live.main.usd + Math.max(0, live.restoredUsd - earlierSub);
  if (mainUsd > 0) rows.push({ label: "Main conversation", model: topModel(live.mainModels), usd: mainUsd, kind: "main" });

  const agents: WentRow[] = [];
  for (const a of Object.values(live.agents)) {
    if (a.usd <= 0) continue;
    agents.push({ label: cut(a.description === "" ? a.type : `${a.type} \u{b7} ${a.description}`), model: a.model, usd: a.usd, kind: "agent" });
  }
  rows.push(...agents.sort(byUsd));

  const earlier: WentRow[] = [];
  for (const [type, usd] of Object.entries(live.restoredSub)) if (usd > 0) earlier.push({ label: `${type} before resume`, model: "", usd, kind: "earlier" });
  rows.push(...earlier.sort(byUsd));

  const side: WentRow[] = [];
  for (const [model, usd] of Object.entries(live.otherByModel)) if (usd > 0) side.push({ label: "Other API calls", model, usd, kind: "side" });
  rows.push(...side.sort(byUsd));

  const seen = rows.reduce((a, r) => a + r.usd, 0);
  const rest = totalUsd(live) - seen;
  if (rest >= NOISE_USD) rows.push({ label: "Other sub-agents", model: "", usd: rest, kind: "rest" });
  return rows;
}

/** Spend by model over the whole session, costliest first: this launch's requests, earlier launches', and side requests. */
export function modelSplit(live: LiveState): Array<[string, number]> {
  const by = new Map<string, number>();
  const add = (model: string, usd: number): void => {
    if (usd > 0) by.set(model, (by.get(model) ?? 0) + usd);
  };
  for (const [m, x] of Object.entries(live.stepped)) add(m, x.usd);
  for (const [m, x] of Object.entries(live.restored)) add(m, x.usd);
  for (const [m, usd] of Object.entries(live.otherByModel)) add(m, usd);
  return [...by.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** Dollars per hour of turn time over this launch; null until a turn ends or while nothing was spent. */
export function perActiveHour(live: LiveState): number | null {
  const launch = totalUsd(live) - live.restoredUsd;
  if (live.activeMs <= 0 || launch <= 0) return null;
  return launch / (live.activeMs / 3_600_000);
}

export type KindRow = { kind: "input" | "output" | "cacheRead" | "cacheWrite" | "cw1h" | "cw5m"; tokens: number; usd: number };

const addTok = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cw5m: a.cw5m + b.cw5m, cw1h: a.cw1h + b.cw1h });

/**
 * Tokens and dollars by kind over the priced requests (this launch's and earlier launches'; side requests carry
 * no per-kind figures). Each kind's dollars are its list-price share of the exact total, so a long-context or fast
 * request does not make the rows disagree with the headline. Cache write comes with its two lives beneath it.
 */
export function kindRows(live: LiveState, prices: PriceTable): KindRow[] {
  let tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 };
  const raw = { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 };
  let exact = 0;
  const each = (model: string, t: Tokens, usd: number): void => {
    tokens = addTok(tokens, t);
    exact += usd;
    const p = resolvePrice(model, prices)?.price;
    if (p === undefined) return;
    raw.input += (t.input * p.input) / 1e6;
    raw.output += (t.output * p.output) / 1e6;
    raw.cacheRead += (t.cacheRead * p.cacheRead) / 1e6;
    raw.cw5m += (t.cw5m * p.cw5m) / 1e6;
    raw.cw1h += (t.cw1h * p.cw1h) / 1e6;
  };
  for (const [m, x] of Object.entries(live.stepped)) each(m, x.tokens, x.usd);
  for (const [m, x] of Object.entries(live.restored)) each(m, x.tokens, x.usd);
  const sum = raw.input + raw.output + raw.cacheRead + raw.cw5m + raw.cw1h;
  const k = sum > 0 ? exact / sum : 0;
  const usd = { input: raw.input * k, output: raw.output * k, cacheRead: raw.cacheRead * k, cw5m: raw.cw5m * k, cw1h: raw.cw1h * k };
  return [
    { kind: "input", tokens: tokens.input, usd: usd.input },
    { kind: "output", tokens: tokens.output, usd: usd.output },
    { kind: "cacheRead", tokens: tokens.cacheRead, usd: usd.cacheRead },
    { kind: "cacheWrite", tokens: tokens.cw1h + tokens.cw5m, usd: usd.cw1h + usd.cw5m },
    { kind: "cw1h", tokens: tokens.cw1h, usd: usd.cw1h },
    { kind: "cw5m", tokens: tokens.cw5m, usd: usd.cw5m },
  ];
}

export type AgentCache = { id: string; label: string; model: string; leftMs: number; refillUsd: number | null };

/** A sub-agent's cache lives this long from its latest request. */
export const AGENT_CACHE_MS = 300_000;

/** The sub-agents whose cache is still warm: time left, and what writing their context again would cost. Soonest to go first. */
export function agentCaches(live: LiveState, now: number, prices: PriceTable): AgentCache[] {
  const out: AgentCache[] = [];
  for (const a of Object.values(live.agents)) {
    if (a.lastTs <= 0) continue;
    const leftMs = a.lastTs + AGENT_CACHE_MS - now;
    if (leftMs <= 0) continue;
    let refillUsd: number | null = null;
    if (a.context > 0 && a.model !== "") {
      const c = costOf(stepRow("", 0, a.id, a.model, { input: 0, output: 0, cacheRead: 0, cw5m: a.context, cw1h: 0 }), prices);
      refillUsd = c.priced ? c.usd : null;
    }
    out.push({ id: a.id, label: cut(a.description === "" ? a.type : `${a.type} \u{b7} ${a.description}`), model: a.model, leftMs, refillUsd });
  }
  return out.sort((a, b) => a.leftMs - b.leftMs || (a.id < b.id ? -1 : 1));
}
