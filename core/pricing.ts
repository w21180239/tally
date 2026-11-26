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

export function costOf(row: UsageRow, table: PriceTable): { usd: number; exact: boolean; priced: boolean } {
  if (row.synthetic) return { usd: 0, exact: true, priced: true };
  const r = resolvePrice(row.model, table);
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
