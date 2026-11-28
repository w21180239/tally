// What the window draws from, as plain data: built once per drawing from the live atom, the foot and the chart.
import type { Hint } from "../core/hint.ts";
import type { LiveState } from "../core/live-state.ts";
import { formatMoney } from "../core/money.ts";
import { tokensText } from "../core/rules/shared.ts";
import { totalUsd } from "../core/where.ts";
import type { Settings } from "../core/settings.ts";
import { CACHE_MARK, chartText, HINT_MARK, SEP } from "./theme.ts";

export type Limit = { kind: string; percentUsed: number; resetsAt?: string };

/** The engine's figures for the foot, kept in an atom: context, where auto-compact starts, limits and the refill price. */
export type Foot = {
  contextTokens: number | null;
  contextWindow: number;
  compactAt: number | null;
  limits: Limit[];
  /** What writing the whole context to the cache again costs on the main model; null when unknown. */
  refillUsd: number | null;
};

/** The last 8 hours' token totals, oldest first, and the rank bands that turn them into glyphs. */
export type Chart = { values: number[]; bands: number[] };

/** The top hint of this session in short words: what was found, and its amount (`~` before a projected one). */
export type HintGlance = { found: string; saving: string | null };

/** A hint's amount, led by `~` for an estimated saving. */
export const amountText = (hint: Pick<Hint, "usd" | "projected">, s: Pick<Settings, "money" | "decimals">): string => `${hint.projected === true ? "~" : ""}${formatMoney(hint.usd, s.money, s.decimals)}`;

/** `hint` in the one-line forms (fold, card, Session tab); no amount when the rule priced none. */
export const glanceOf = (hint: Hint, s: Pick<Settings, "money" | "decimals">): HintGlance => ({ found: hint.short, saving: hint.usd > 0 ? amountText(hint, s) : null });

export type Cache = { leftMs: number; lifeMs: number; isExpired: boolean; refillUsd: number | null };

export type WindowData = {
  now: number;
  money: Settings["money"];
  decimals: Settings["decimals"];
  costUsd: number;
  agents: number;
  /** This launch's spend by model family, costliest first. */
  models: Array<[string, number]>;
  context: { tokens: number | null; window: number; compactAt: number | null };
  limits: Limit[];
  cache: Cache | null;
  chart: string | null;
  hint: HintGlance | null;
};

export const EMPTY_FOOT: Foot = { contextTokens: null, contextWindow: 0, compactAt: null, limits: [], refillUsd: null };
export const EMPTY_CHART: Chart = { values: [], bands: [] };

const LIFE_MS = { "5m": 300_000, "1h": 3_600_000 } as const;

export const sessionUsd = totalUsd;

/** A model id's family: opus, sonnet, haiku, fable, mythos, else the id itself. */
export const familyOf = (model: string): string => /(opus|sonnet|haiku|fable|mythos)/i.exec(model)?.[1]?.toLowerCase() ?? model;

/** This launch's spend by family, costliest first (ties by name). */
export function familyCosts(live: LiveState): Array<[string, number]> {
  const by = new Map<string, number>();
  for (const [model, m] of Object.entries(live.stepped)) by.set(familyOf(model), (by.get(familyOf(model)) ?? 0) + m.usd);
  return [...by.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** Main's cache: how long its last write has left, from the write's time and life. */
export function cacheOf(lastWrite: LiveState["lastWrite"], now: number, refillUsd: number | null): Cache | null {
  if (lastWrite === undefined) return null;
  const lifeMs = LIFE_MS[lastWrite.ttl];
  const leftMs = lastWrite.ts + lifeMs - now;
  return { leftMs: Math.max(0, leftMs), lifeMs, isExpired: leftMs <= 0, refillUsd };
}

export type DataIn = { live: LiveState; foot: Foot; chart: Chart; hint?: HintGlance | null; settings: Pick<Settings, "money" | "decimals">; now: number };

export function windowData(i: DataIn): WindowData {
  // No chart while no hour of the 8 has a request: eight dots say nothing.
  const chart = i.chart.values.some((v) => v > 0) ? chartText(i.chart.values.slice(-8), i.chart.bands) : null;
  return {
    now: i.now,
    money: i.settings.money,
    decimals: i.settings.decimals,
    costUsd: sessionUsd(i.live),
    agents: Object.keys(i.live.agents).length,
    models: familyCosts(i.live),
    context: { tokens: i.foot.contextTokens, window: i.foot.contextWindow, compactAt: i.foot.compactAt },
    limits: i.foot.limits,
    cache: cacheOf(i.live.lastWrite, i.now, i.foot.refillUsd),
    chart,
    hint: i.hint ?? null,
  };
}

export const moneyOf = (d: Pick<WindowData, "money" | "decimals">, usd: number): string => formatMoney(usd, d.money, d.decimals);

export { tokensText };

export const percentText = (share: number): string => `${Math.round(share * 100)}%`;

/** A cache's time left: `<1m`, whole minutes, then hours and minutes. No seconds: the display is redrawn at most every 15 s. */
export function leftText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "<1m";
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Time until an ISO timestamp: `4h 20m`, `3d 5h`, `now` once it has passed; null when unparseable. */
export function untilText(iso: string | undefined, now: number): string | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const min = Math.floor((at - now) / 60_000);
  if (min <= 0) return "now";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
}

export function limitName(kind: string, short: boolean): string {
  if (kind === "five_hour") return short ? "5h" : "5-hour";
  if (kind === "seven_day") return short ? "7d" : "7-day";
  return kind.replace(/_/g, " ");
}

export const contextShare = (d: WindowData): number | null => (d.context.tokens === null || d.context.window <= 0 ? null : d.context.tokens / d.context.window);

/** `ctx 236k (24%)`; before the first request `ctx -`. */
export function contextWords(d: WindowData): string {
  const share = contextShare(d);
  if (d.context.tokens === null) return "ctx -";
  return share === null ? `ctx ${tokensText(d.context.tokens)}` : `ctx ${tokensText(d.context.tokens)} (${percentText(share)})`;
}

export function cacheWords(d: WindowData): string | null {
  if (d.cache === null) return null;
  return d.cache.isExpired ? `${CACHE_MARK} expired` : `${CACHE_MARK} ${leftText(d.cache.leftMs)}`;
}

/** The short view's lines: cost, context and limits, cache, then the chart and hint; each cut to `cols`. */
export function glanceLines(d: WindowData, cols: number): string[] {
  const cut = (s: string): string => (s.length > cols ? `${s.slice(0, Math.max(0, cols - 1))}\u{2026}` : s);
  const lines: string[] = [];
  lines.push(`${moneyOf(d, d.costUsd)} session${d.agents > 0 ? `${SEP}${d.agents} sub-agent${d.agents === 1 ? "" : "s"}` : ""}`);
  const ctx = [contextWords(d), ...d.limits.map((l) => `${limitName(l.kind, true)} ${Math.round(l.percentUsed)}%`)];
  lines.push(ctx.join(SEP));
  const cache = d.cache === null ? null : `cache ${d.cache.isExpired ? "expired" : leftText(d.cache.leftMs)}${d.cache.refillUsd === null ? "" : `${SEP}rewrite cost ${moneyOf(d, d.cache.refillUsd)}`}`;
  if (cache !== null) lines.push(cache);
  if (d.chart !== null) lines.push(`8h ${d.chart}`);
  if (d.hint !== null) lines.push(`${HINT_MARK} ${d.hint.found}${d.hint.saving === null ? "" : `${SEP}${d.hint.saving}`}`);
  return lines.map(cut);
}
