import { describe, expect, test } from "claude-code/testing";
import { acceptable, parsePricing } from "../core/price-parse.ts";
import type { PriceTable } from "../core/pricing.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { maybeUpdatePrices, PRICE_ERROR_KEY, PRICES_KEY, PRICING_URL, RETRY_GAP_MS, STALE_MS } from "../engine/price-update.ts";
import { PRICING_MD } from "./fixtures/pricing-sample.ts";
import { START_MS, worldOf } from "./world.ts";

function parsed(md: string): PriceTable {
  const t = parsePricing(md);
  if ("error" in t) throw new Error(t.error);
  return t;
}

// Drops every second row of the model table; the fast table stays so only the model count falls.
function halve(md: string): string {
  let n = 0;
  return md
    .split("\n")
    .filter((l) => !/^\| Claude (?!Haiku 5\.5)[^|]*(\|[^|]*){5}\|\s*$/.test(l) || ++n % 2 === 1)
    .join("\n");
}

type Reply = { status: number; ok: boolean; text: string } | Error;

// A world `$` with a counting `$.http.fetch` that answers from `reply`.
function netWorld(reply: () => Reply, storeEntries: Record<string, unknown> = {}) {
  const w = worldOf(storeEntries);
  const calls: string[] = [];
  const $ = {
    ...w.$,
    http: {
      async fetch(url: string) {
        calls.push(url);
        const r = reply();
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  return { w, $, calls };
}

const okMd = (text: string): Reply => ({ status: 200, ok: true, text });
const week = STALE_MS;
const ON = { priceUpdate: true };

describe("parsePricing", () => {
  test("the fixture yields the builtin table model for model", () => {
    const t = parsed(PRICING_MD);
    expect(t.source).toBe("fetched");
    expect(Object.keys(t.models).sort()).toEqual(Object.keys(BUILTIN_PRICES.models).sort());
    for (const [id, want] of Object.entries(BUILTIN_PRICES.models)) expect(t.models[id]).toEqual(want);
    expect(t.fastMul).toBe(BUILTIN_PRICES.fastMul);
  });

  test("the Haiku 5.5 long-context tier is read from the over-threshold row", () => {
    const t = parsed(PRICING_MD);
    expect(t.models["claude-haiku-5-5"].longContext).toEqual({ threshold: 100000, inputMul: 5, outputMul: 5 });
    expect(t.models["claude-haiku-5-5"].input).toBe(0.1);
    expect(t.models["claude-haiku-4-5"].longContext).toBeUndefined();
  });

  test("updatedAt comes from the optional argument", () => {
    expect(parsed(PRICING_MD).updatedAt).toBe(0);
    const t = parsePricing(PRICING_MD, 123);
    expect("error" in t ? -1 : t.updatedAt).toBe(123);
  });

  test("a page without the model table is an error", () => {
    const t = parsePricing("# Pricing\n\nNothing here.\n");
    expect("error" in t).toBe(true);
  });

  test("a page without the fast table is an error", () => {
    const md = PRICING_MD.replace("### Fast mode pricing", "### Something else");
    expect("error" in parsePricing(md)).toBe(true);
  });

  test("fast prices that are not one multiple of base are an error", () => {
    const md = PRICING_MD.replace("| Claude Opus 5.5 | $8 USD / MTok | $40 USD / MTok |", "| Claude Opus 5.5 | $8 USD / MTok | $60 USD / MTok |");
    expect("error" in parsePricing(md)).toBe(true);
  });

  test("a long-context tier whose cache classes do not scale with input is an error", () => {
    const md = PRICING_MD.replace("| $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |", "| $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.09 / MTok | $2.50 / MTok |");
    expect("error" in parsePricing(md)).toBe(true);
  });

  test("columns are found by header name, so a reordered table parses the same", () => {
    const reordered = PRICING_MD.split("\n")
      .map((l) => {
        if (!/^\| (Model|Claude) /.test(l)) return l;
        const c = l.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((s) => s.trim());
        if (c.length !== 6) return l;
        const [n, a, b, cc, d, e] = c;
        return `| ${[n, e, a, d, cc, b].join(" | ")} |`;
      })
      .join("\n");
    expect(reordered).not.toBe(PRICING_MD);
    expect(parsed(reordered).models).toEqual(BUILTIN_PRICES.models);
  });

  test("a table without a recognisable header row is an error", () => {
    const md = PRICING_MD.replace("| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |", "| Model | A | B | C | D | E |");
    expect("error" in parsePricing(md)).toBe(true);
  });

  test("a row with a missing price cell is skipped", () => {
    const md = PRICING_MD.replace("| Claude Opus 4.5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |", "| Claude Opus 4.5 | soon | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |");
    expect(Object.keys(parsed(md).models)).not.toContain("claude-opus-4-5");
  });
});

describe("acceptable", () => {
  test("the full fixture table is accepted against the builtin", () => {
    expect(acceptable(parsed(PRICING_MD), BUILTIN_PRICES)).toBe(true);
  });

  test("half the model rows removed is rejected", () => {
    const half = parsed(halve(PRICING_MD));
    expect(Object.keys(half.models).length).toBeLessThan(Object.keys(BUILTIN_PRICES.models).length * 0.8);
    expect(acceptable(half, BUILTIN_PRICES)).toBe(false);
  });

  test("exactly 80% of the previous count passes, one model fewer fails", () => {
    const ids = Object.keys(BUILTIN_PRICES.models);
    const prev: PriceTable = { ...BUILTIN_PRICES, models: Object.fromEntries(ids.slice(0, 10).map((k) => [k, BUILTIN_PRICES.models[k]])) };
    const next = (n: number): PriceTable => ({ ...BUILTIN_PRICES, models: Object.fromEntries(ids.slice(0, n).map((k) => [k, BUILTIN_PRICES.models[k]])) });
    expect(acceptable(next(8), prev)).toBe(true);
    expect(acceptable(next(7), prev)).toBe(false);
  });

  test("a model whose 5m cache write is not 1.25x input is rejected", () => {
    const t = parsed(PRICING_MD);
    t.models["claude-opus-5"] = { ...t.models["claude-opus-5"], cw5m: 7 };
    expect(acceptable(t, BUILTIN_PRICES)).toBe(false);
  });

  test("a non-positive or non-finite price is rejected", () => {
    const t = parsed(PRICING_MD);
    t.models["claude-opus-5"] = { ...t.models["claude-opus-5"], output: 0 };
    expect(acceptable(t, BUILTIN_PRICES)).toBe(false);
    const u = parsed(PRICING_MD);
    u.models["claude-opus-5"] = { ...u.models["claude-opus-5"], cacheRead: Number.NaN };
    expect(acceptable(u, BUILTIN_PRICES)).toBe(false);
  });

  test("a model whose cache read and output are swapped is rejected", () => {
    const t = parsed(PRICING_MD);
    const m = t.models["claude-opus-5"];
    t.models["claude-opus-5"] = { ...m, cacheRead: m.output, output: m.cacheRead };
    expect(acceptable(t, BUILTIN_PRICES)).toBe(false);
  });

  test("a model whose 1h cache write is not 2x input is rejected", () => {
    const t = parsed(PRICING_MD);
    t.models["claude-opus-5"] = { ...t.models["claude-opus-5"], cw1h: 7 };
    expect(acceptable(t, BUILTIN_PRICES)).toBe(false);
  });

  test("a bad fast multiplier is rejected", () => {
    expect(acceptable({ ...parsed(PRICING_MD), fastMul: 0 }, BUILTIN_PRICES)).toBe(false);
  });
});

describe("maybeUpdatePrices", () => {
  test("priceUpdate off: no fetch, builtin returned", async () => {
    const { $, calls } = netWorld(() => okMd(PRICING_MD));
    const t = await maybeUpdatePrices($, { priceUpdate: false });
    expect(calls.length).toBe(0);
    expect(t).toEqual(BUILTIN_PRICES);
  });

  test("priceUpdate off: a stored table is still the one in effect", async () => {
    const stored = { ...parsed(PRICING_MD), updatedAt: START_MS - 100 * week };
    const { $, calls } = netWorld(() => okMd(PRICING_MD), { [PRICES_KEY]: stored });
    const t = await maybeUpdatePrices($, { priceUpdate: false });
    expect(calls.length).toBe(0);
    expect(t).toEqual(stored);
  });

  test("no stored table: fetches the pricing page, stores the result, clears priceError", async () => {
    const { w, $, calls } = netWorld(() => okMd(PRICING_MD), { [PRICE_ERROR_KEY]: { at: START_MS - RETRY_GAP_MS - 1, message: "old" } });
    const t = await maybeUpdatePrices($, ON);
    expect(calls).toEqual([PRICING_URL]);
    expect(PRICING_URL).toBe("https://platform.claude.com/docs/en/about-claude/pricing.md");
    expect(t.source).toBe("fetched");
    expect(t.updatedAt).toBe(w.time());
    expect(t.models).toEqual(BUILTIN_PRICES.models);
    expect(w.stored.get(PRICES_KEY)).toEqual(t);
    expect(w.stored.has(PRICE_ERROR_KEY)).toBe(false);
  });

  test("a fetched table is merged over the builtin: a model the page dropped keeps its builtin price", async () => {
    const md = PRICING_MD.split("\n").filter((l) => !l.startsWith("| Claude Opus 4.5 |")).join("\n");
    const { $ } = netWorld(() => okMd(md));
    const t = await maybeUpdatePrices($, ON);
    expect(parsed(md).models["claude-opus-4-5"]).toBeUndefined();
    expect(t.source).toBe("fetched");
    expect(t.models["claude-opus-4-5"]).toEqual(BUILTIN_PRICES.models["claude-opus-4-5"]);
  });

  test("a table fetched less than 7 days ago is not refetched", async () => {
    const stored = { ...parsed(PRICING_MD), updatedAt: START_MS - (week - 1000) };
    const { $, calls } = netWorld(() => okMd(PRICING_MD), { [PRICES_KEY]: stored });
    const t = await maybeUpdatePrices($, ON);
    expect(calls.length).toBe(0);
    expect(t).toEqual(stored);
  });

  test("a table older than 7 days is refetched and replaced", async () => {
    const stored = { ...parsed(PRICING_MD), updatedAt: START_MS - week - 1 };
    const { w, $, calls } = netWorld(() => okMd(PRICING_MD), { [PRICES_KEY]: stored });
    const t = await maybeUpdatePrices($, ON);
    expect(calls.length).toBe(1);
    expect(t.updatedAt).toBe(w.time());
    expect((w.stored.get(PRICES_KEY) as PriceTable).updatedAt).toBe(w.time());
  });

  test("a stored timestamp in the future counts as stale", async () => {
    const stored = { ...parsed(PRICING_MD), updatedAt: START_MS + 10 * week };
    const { $, calls } = netWorld(() => okMd(PRICING_MD), { [PRICES_KEY]: stored });
    await maybeUpdatePrices($, ON);
    expect(calls.length).toBe(1);
  });

  test("a malformed stored value is ignored", async () => {
    const { $, calls } = netWorld(() => ({ status: 500, ok: false, text: "" }), { [PRICES_KEY]: { models: 3 } });
    const t = await maybeUpdatePrices($, ON);
    expect(calls.length).toBe(1);
    expect(t).toEqual(BUILTIN_PRICES);
  });

  const failures: [string, () => Reply][] = [
    ["an HTTP error", () => ({ status: 503, ok: false, text: "down" })],
    ["a network error", () => new Error("offline")],
    ["an unparsable page", () => okMd("# Pricing\n\nmoved\n")],
    ["a page that lost half the models", () => okMd(halve(PRICING_MD))],
  ];
  for (const [name, reply] of failures) {
    test(`${name}: keeps the old table and records priceError`, async () => {
      const stored = { ...parsed(PRICING_MD), updatedAt: START_MS - 2 * week };
      const { w, $ } = netWorld(reply, { [PRICES_KEY]: stored });
      const t = await maybeUpdatePrices($, ON);
      expect(t).toEqual(stored);
      expect(w.stored.get(PRICES_KEY)).toEqual(stored);
      const err = w.stored.get(PRICE_ERROR_KEY) as { at: number; message: string };
      expect(err.at).toBe(w.time());
      expect(typeof err.message).toBe("string");
      expect(err.message.length).toBeGreaterThan(0);
      expect(err.message.length).toBeLessThanOrEqual(200);
    });
  }

  test("a failure with no stored table falls back to the builtin", async () => {
    const { $ } = netWorld(() => new Error("offline"));
    expect(await maybeUpdatePrices($, ON)).toEqual(BUILTIN_PRICES);
  });

  test("a recent failure holds off the next attempt until the retry gap passes", async () => {
    const { w, $, calls } = netWorld(() => new Error("offline"));
    await maybeUpdatePrices($, ON);
    await maybeUpdatePrices($, ON);
    expect(calls.length).toBe(1);
    await w.advance(RETRY_GAP_MS + 1);
    await maybeUpdatePrices($, ON);
    expect(calls.length).toBe(2);
  });

  test("a later success clears priceError", async () => {
    let up = false;
    const { w, $ } = netWorld(() => (up ? okMd(PRICING_MD) : new Error("offline")));
    await maybeUpdatePrices($, ON);
    expect(w.stored.has(PRICE_ERROR_KEY)).toBe(true);
    up = true;
    await w.advance(RETRY_GAP_MS + 1);
    await maybeUpdatePrices($, ON);
    expect(w.stored.has(PRICE_ERROR_KEY)).toBe(false);
  });

  test("the stored table stays small", async () => {
    const { w, $ } = netWorld(() => okMd(PRICING_MD));
    await maybeUpdatePrices($, ON);
    expect(JSON.stringify(w.stored.get(PRICES_KEY)).length).toBeLessThan(4000);
  });
});
