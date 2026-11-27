// Weekly refresh of the price table from the pricing page; the only network call tally makes.
import { acceptable, parsePricing } from "../core/price-parse.ts";
import type { PriceTable } from "../core/pricing.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";

export const PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";
/** `$.store` key of the fetched `PriceTable`. */
export const PRICES_KEY = "prices";
/** `$.store` key of `{ at, message }` for the last failed update; cleared by a good one. */
export const PRICE_ERROR_KEY = "priceError";
/** A stored table older than this is refetched. */
export const STALE_MS = 7 * 24 * 3600 * 1000;
/** After a failed attempt the next one waits this long, so an offline machine does not retry every session. */
export const RETRY_GAP_MS = 6 * 3600 * 1000;

export type PriceEnv = {
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };
  clock: { now(): Promise<number> };
  http: { fetch(url: string): Promise<{ status: number; ok: boolean; text: string }> };
};

export type PriceError = { at: number; message: string };

function asTable(v: unknown): PriceTable | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const t = v as Partial<PriceTable>;
  const ok = typeof t.updatedAt === "number" && typeof t.fastMul === "number" && typeof t.models === "object" && t.models !== null;
  return ok ? (t as PriceTable) : undefined;
}

/** The price table in effect: the stored fetched one, else the builtin. */
export async function currentPrices($: Pick<PriceEnv, "store">): Promise<PriceTable> {
  return asTable(await $.store.get(PRICES_KEY).catch(() => undefined)) ?? BUILTIN_PRICES;
}

/** The last update failure for the Help tab, if any. */
export async function lastPriceError($: Pick<PriceEnv, "store">): Promise<PriceError | undefined> {
  const v = (await $.store.get(PRICE_ERROR_KEY).catch(() => undefined)) as Partial<PriceError> | undefined;
  return v && typeof v.at === "number" && typeof v.message === "string" ? { at: v.at, message: v.message } : undefined;
}

export async function maybeUpdatePrices($: PriceEnv, settings: { priceUpdate: boolean }): Promise<PriceTable> {
  const stored = asTable(await $.store.get(PRICES_KEY).catch(() => undefined));
  const prev = stored ?? BUILTIN_PRICES;
  if (!settings.priceUpdate) return prev;
  const now = await $.clock.now();
  if (stored && now >= stored.updatedAt && now - stored.updatedAt < STALE_MS) return stored;
  const lastErr = await lastPriceError($);
  if (lastErr && now >= lastErr.at && now - lastErr.at < RETRY_GAP_MS) return prev;

  const fail = async (message: string): Promise<PriceTable> => {
    await $.store.set(PRICE_ERROR_KEY, { at: now, message: message.slice(0, 200) }).catch(() => undefined);
    return prev;
  };
  let res: { status: number; ok: boolean; text: string };
  try {
    res = await $.http.fetch(PRICING_URL);
  } catch (e) {
    return fail(`price fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) return fail(`price page answered HTTP ${res.status}`);
  const next = parsePricing(res.text, now);
  if ("error" in next) return fail(`price page not understood: ${next.error}`);
  if (!acceptable(next, prev)) return fail("price page failed the sanity check; kept the previous prices");
  await $.store.set(PRICES_KEY, next);
  await $.store.delete(PRICE_ERROR_KEY).catch(() => undefined);
  return next;
}
