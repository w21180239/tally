import type { UsageRow } from "./types.ts";

export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cw5m: number;
  cw1h: number;
  longContext?: { threshold: number; inputMul: number; outputMul: number };
};

export type PriceTable = {
  source: "builtin" | "fetched";
  updatedAt: number;
  models: Record<string, ModelPrice>;
  fastMul: number;
};

const FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];

// "claude-opus-4-5-20251101[1m]" -> { family: "opus", version: [4, 5] }
function parseId(model: string): { key: string; family: string; version: number[] } | null {
  const id = model.toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  if (!id.startsWith("claude-")) return null;
  const parts = id.split("-");
  const family = parts.find((s) => FAMILIES.includes(s));
  if (!family) return null;
  const i = parts.indexOf(family);
  const version: number[] = [];
  for (const s of parts.slice(i + 1)) {
    if (!/^\d+$/.test(s)) break;
    version.push(Number(s));
  }
  return { key: parts.slice(0, i + 1 + version.length).join("-"), family, version };
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function resolvePrice(model: string, table: PriceTable): { price: ModelPrice; exact: boolean } | null {
  const id = parseId(model);
  if (!id) return null;
  const hit = table.models[id.key];
  if (hit) return { price: hit, exact: true };
  let best: { price: ModelPrice; version: number[] } | null = null;
  for (const [k, price] of Object.entries(table.models)) {
    const c = parseId(k);
    if (!c || c.family !== id.family) continue;
    if (!best || cmp(c.version, best.version) > 0) best = { price, version: c.version };
  }
  return best ? { price: best.price, exact: false } : null;
}

export type Resolver = (model: string) => ReturnType<typeof resolvePrice>;

/** `resolvePrice` remembered per model, for loops over many rows of few models. */
export function memoResolver(table: PriceTable): Resolver {
  const seen = new Map<string, ReturnType<typeof resolvePrice>>();
  return (model) => {
    if (!seen.has(model)) seen.set(model, resolvePrice(model, table));
    return seen.get(model) ?? null;
  };
}

export function costOf(row: UsageRow, table: PriceTable, resolve: Resolver = (m) => resolvePrice(m, table)): { usd: number; exact: boolean; priced: boolean } {
  if (row.synthetic) return { usd: 0, exact: true, priced: true };
  const r = resolve(row.model);
  if (!r) return { usd: 0, exact: false, priced: false };
  const { price: p } = r;
  const t = row.tokens;
  const lc = p.longContext;
  const over = lc !== undefined && t.input + t.cacheRead + t.cw5m + t.cw1h > lc.threshold;
  const inMul = over ? lc.inputMul : 1;
  const outMul = over ? lc.outputMul : 1;
  const inputSide = t.input * p.input + t.cacheRead * p.cacheRead + t.cw5m * p.cw5m + t.cw1h * p.cw1h;
  let usd = (inputSide * inMul + t.output * p.output * outMul) / 1e6;
  if (row.fast) usd *= table.fastMul;
  return { usd, exact: r.exact, priced: true };
}

/** USD per token of one request's cache read and cache writes, with the long-context and fast multipliers applied. */
export function cacheUnitPrices(row: UsageRow, table: PriceTable, resolve: Resolver = (m) => resolvePrice(m, table)): { read: number; cw5m: number; cw1h: number } {
  const r = row.synthetic ? null : resolve(row.model);
  if (!r) return { read: 0, cw5m: 0, cw1h: 0 };
  const { price: p } = r;
  const t = row.tokens;
  const lc = p.longContext;
  const mul = (lc !== undefined && t.input + t.cacheRead + t.cw5m + t.cw1h > lc.threshold ? lc.inputMul : 1) * (row.fast ? table.fastMul : 1) / 1e6;
  return { read: p.cacheRead * mul, cw5m: p.cw5m * mul, cw1h: p.cw1h * mul };
}

/** USD per token of one request's four billed kinds, with the long-context and fast multipliers applied (zeros when unpriced). */
export function unitPrices(row: UsageRow, table: PriceTable, resolve: Resolver = (m) => resolvePrice(m, table)): { input: number; output: number; read: number; cw5m: number; cw1h: number } {
  const r = row.synthetic ? null : resolve(row.model);
  if (!r) return { input: 0, output: 0, read: 0, cw5m: 0, cw1h: 0 };
  const { price: p } = r;
  const t = row.tokens;
  const lc = p.longContext;
  const over = lc !== undefined && t.input + t.cacheRead + t.cw5m + t.cw1h > lc.threshold;
  const fast = (row.fast ? table.fastMul : 1) / 1e6;
  const inMul = (over ? lc.inputMul : 1) * fast;
  return { input: p.input * inMul, output: p.output * (over ? lc.outputMul : 1) * fast, read: p.cacheRead * inMul, cw5m: p.cw5m * inMul, cw1h: p.cw1h * inMul };
}
