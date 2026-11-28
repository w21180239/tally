// Money formatting for every surface. The result never passes 7 characters.
import type { Settings } from "./settings.ts";

const MAX_LEN = 7;
const CENT = "\u{a2}";

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const trimZeros = (s: string): string => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

// Whole dollars: grouped, then ungrouped, then compact (M/B/T) so the total fits `limit`.
function wholeDollars(usd: number, limit: number): string {
  const n = Math.round(usd);
  for (const s of [`$${group(String(n))}`, `$${n}`]) if (s.length <= limit) return s;
  const units: [number, string][] = [[1e6, "M"], [1e9, "B"], [1e12, "T"]];
  for (const [size, unit] of units) {
    const v = n / size;
    if (Math.round(v) >= 1000 && unit !== "T") continue;
    for (let d = 2; d >= 0; d--) {
      const s = `$${trimZeros(v.toFixed(d))}${unit}`;
      if (s.length <= limit) return s;
    }
  }
  return "$999T";
}

// From $1,000 up only whole dollars fit; below that, `places` decimals shrink until the total fits.
function dollars(usd: number, places: number, limit: number): string {
  if (Math.round(usd * 100) >= 100_000) return wholeDollars(usd, limit);
  for (let d = places; d > 0; d--) {
    const s = `$${usd.toFixed(d)}`;
    if (s.length <= limit) return s;
  }
  return wholeDollars(usd, limit);
}

function cents(usd: number, places: number, trim: boolean, limit: number): string {
  const c = usd * 100;
  if (Math.round(c) >= 100_000) return wholeDollars(usd, limit);
  for (let d = places; d >= 0; d--) {
    const s = `${trim ? trimZeros(c.toFixed(d)) : c.toFixed(d)}\u00a2`;
    if (s.length <= limit) return s;
  }
  return `${Math.round(c)}\u00a2`;
}

/**
 * The amounts of one column in one unit, so a column reads as one scale and lines up on its right edge.
 *
 * `money` picks the unit: dollars, cents, or (cents-and-dollars) dollars when the block's largest amount is $1 or
 * more, else cents. `decimals` auto is two places in dollars and one in cents; a number fixes them. Places shrink
 * together until the widest amount fits 7 characters. A positive amount that rounds to zero reads `<$0.01` or
 * `<0.1` cents. From $1,000 the block drops to whole dollars, the only unit that fits.
 */
export function moneyBlock(values: readonly number[], money: Settings["money"], decimals: Settings["decimals"]): string[] {
  const xs = values.map((v) => (Number.isFinite(v) ? v : 0));
  const max = xs.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
  const limit = xs.some((v) => v < 0) ? MAX_LEN - 1 : MAX_LEN;
  const signed = (v: number, body: string): string => (v < 0 ? `-${body}` : body);
  if (Math.round(max * 100) >= 100_000) return xs.map((v) => signed(v, wholeDollars(Math.abs(v), limit)));

  const inDollars = money === "dollars" || (money === "cents-and-dollars" && Math.round(max * 100) >= 100);
  const dollarForm = (abs: number, d: number): string => `$${abs.toFixed(d)}`;
  const centForm = (abs: number, d: number): string => `${(abs * 100).toFixed(d)}${CENT}`;
  const widest = (d: number): number => (inDollars ? dollarForm(max, d) : centForm(max, d)).length;
  let places = decimals === "auto" ? (inDollars ? 2 : 1) : Number(decimals);
  while (places > 0 && widest(places) > limit) places--;

  const unit = 10 ** -places;
  return xs.map((v) => {
    const abs = Math.abs(v);
    const scaled = inDollars ? abs : abs * 100;
    if (abs > 0 && Math.round(scaled / unit) === 0) return signed(v, inDollars ? `<$${unit.toFixed(places)}` : `<${unit.toFixed(places)}${CENT}`);
    return signed(v, inDollars ? dollarForm(abs, places) : centForm(abs, places));
  });
}

/** One amount that heads a view: dollars unless the setting says cents, so the first number reads the same everywhere. */
export const headlineMoney = (usd: number, money: Settings["money"], decimals: Settings["decimals"]): string => moneyBlock([usd], money === "cents-and-dollars" ? "dollars" : money, decimals)[0]!;

// Non-finite input shows as zero; a negative amount gets a leading "-" inside the same 7 characters.
export function formatMoney(usd: number, money: Settings["money"], decimals: Settings["decimals"]): string {
  const x = Number.isFinite(usd) ? usd : 0;
  const neg = x < 0;
  const abs = Math.abs(x);
  const limit = neg ? MAX_LEN - 1 : MAX_LEN;
  const auto = decimals === "auto";
  const places = auto ? 2 : Number(decimals);

  let body: string;
  if (money === "dollars") body = dollars(abs, places, limit);
  else if (money === "cents") body = cents(abs, places, auto, limit);
  else {
    // Cents under $1 (judged after rounding to 0.01 cent), dollars from $1.
    const centsFirst = Math.round(abs * 10_000) < 10_000;
    body = centsFirst ? cents(abs, places, auto, limit) : dollars(abs, places, limit);
  }
  return neg ? `-${body}` : body;
}
