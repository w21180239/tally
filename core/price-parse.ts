// Reads the model price table, the Haiku long-context tier and the fast-mode multiple from the pricing page markdown.
import type { ModelPrice, PriceTable } from "./pricing.ts";

const NAME = /^Claude\s+([A-Za-z]+)\s+(\d+(?:\.\d+)*)\b(.*)$/;
const PRICE = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*(?:USD\s*)?\/\s*MTok/;
const TIER = /prompts?\s+(up to|over)\s+(\d[\d,]*)\s+tokens/i;
const EPS = 1e-6;

const close = (a: number, b: number): boolean => Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const idOf = (family: string, version: string): string => `claude-${family.toLowerCase()}-${version.replace(/\./g, "-")}`;

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function price(cell: string | undefined): number | null {
  const m = cell === undefined ? null : PRICE.exec(cell);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

// Lines under the heading that starts with `head`, up to the next heading of the same or a higher level.
function section(lines: string[], head: string): string[] | null {
  const level = /^#+/.exec(head)![0].length;
  const at = lines.findIndex((l) => l.trim() === head);
  if (at < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const h = /^(#+)\s/.exec(l);
    if (h && h[1].length <= level) break;
    out.push(l);
  }
  return out;
}

type Row = { input: number; cw5m: number; cw1h: number; cacheRead: number; output: number };
type Tier = { threshold: number; row: Row };

export function parsePricing(md: string, now = 0): PriceTable | { error: string } {
  const lines = md.split(/\r?\n/);
  const body = section(lines, "## Model pricing");
  if (!body) return { error: "model pricing section not found" };

  const base = new Map<string, Row>();
  const tiers = new Map<string, Tier>();
  const baseThreshold = new Map<string, number>();
  for (const line of body) {
    if (!line.trim().startsWith("|")) continue;
    const c = cells(line);
    const name = NAME.exec(c[0] ?? "");
    if (!name) continue;
    const p = c.slice(1, 6).map(price);
    if (p.length < 5 || p.some((v) => v === null)) continue;
    const [input, cw5m, cw1h, cacheRead, output] = p as number[];
    const row: Row = { input, cw5m, cw1h, cacheRead, output };
    const id = idOf(name[1], name[2]);
    const tier = TIER.exec(name[3]);
    const threshold = tier ? Number(tier[2].replace(/,/g, "")) : 0;
    if (tier && tier[1].toLowerCase() === "over") {
      if (!tiers.has(id)) tiers.set(id, { threshold, row });
    } else if (!base.has(id)) {
      base.set(id, row);
      if (tier) baseThreshold.set(id, threshold);
    }
  }
  if (base.size === 0) return { error: "no model rows in the model pricing table" };

  const models: Record<string, ModelPrice> = {};
  for (const [id, r] of base) models[id] = { input: r.input, output: r.output, cacheRead: r.cacheRead, cw5m: r.cw5m, cw1h: r.cw1h };
  for (const [id, t] of tiers) {
    const b = base.get(id);
    if (!b) return { error: `long-context row without a base row for ${id}` };
    if (baseThreshold.has(id) && baseThreshold.get(id) !== t.threshold) return { error: `long-context thresholds differ for ${id}` };
    const inputMul = round6(t.row.input / b.input);
    const outputMul = round6(t.row.output / b.output);
    const uniform = close(t.row.cw5m, b.cw5m * inputMul) && close(t.row.cw1h, b.cw1h * inputMul) && close(t.row.cacheRead, b.cacheRead * inputMul);
    if (!uniform) return { error: `long-context tier of ${id} does not scale every input class alike` };
    models[id].longContext = { threshold: t.threshold, inputMul, outputMul };
  }

  const fast = section(lines, "### Fast mode pricing");
  if (!fast) return { error: "fast mode pricing section not found" };
  const ratios: number[] = [];
  for (const line of fast) {
    if (!line.trim().startsWith("|")) continue;
    const c = cells(line);
    const fin = price(c[1]);
    const fout = price(c[2]);
    if (fin === null || fout === null) continue;
    for (const part of (c[0] ?? "").split(/\s\/\s/)) {
      const m = NAME.exec(part.trim());
      const b = m ? models[idOf(m[1], m[2])] : undefined;
      if (b) ratios.push(fin / b.input, fout / b.output);
    }
  }
  if (ratios.length === 0) return { error: "no fast mode prices matched a model" };
  if (!ratios.every((r) => close(r, ratios[0]))) return { error: "fast mode is not one multiple of the base prices" };

  return { source: "fetched", updatedAt: now, models, fastMul: round6(ratios[0]) };
}

const positive = (n: number): boolean => Number.isFinite(n) && n > 0;

// A fetched table replaces `prev` only if it keeps at least 80% of its models and every model is well-formed.
export function acceptable(next: PriceTable, prev: PriceTable): boolean {
  const n = Object.keys(next.models).length;
  if (n === 0 || n * 10 < Object.keys(prev.models).length * 8) return false;
  if (!positive(next.fastMul)) return false;
  return Object.values(next.models).every(
    (m) => [m.input, m.output, m.cacheRead, m.cw5m, m.cw1h].every(positive) && close(m.cw5m, 1.25 * m.input),
  );
}
