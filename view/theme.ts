// The palette, glyphs and the two bar drawings (text and Svg) shared by every view. Non-ASCII glyphs are escapes.
//
// Tokens (only theme keys on the terminal, so the contrast is the user's theme and no signal rests on colour alone):
//   text      no colour: labels, figures, bar fills
//   muted     dimColor: notes, rules, secondary figures; never the only carrier of a state
//   accent    "claude": key names, the hint mark; sits under 3:1 on a light theme, so it only ever tints a word
//   ok/warn/crit  success / warning / error: thresholds only. warn comes with a word ("near limit"), crit with CRIT_MARK
//   saving    success, after the word "save"; costs stay text
//   selected  bold + underline (colour may add to it)
//   category  a glyph from PART_GLYPHS plus a colour from PART_COLORS; never the status colours
// Svg cannot take a theme key, so BAR_FILL and PART_FILLS are fixed fills, each at least 3:1 on white and on #1e1e1e.

export type Tone = "success" | "warning" | "error" | "accent" | "dim" | "text";

/** Used-share thresholds: a figure is amber from half and red from 80%. */
export const WARN_SHARE = 0.5;
export const HOT_SHARE = 0.8;
/** A cache is amber when a fifth of its life or less is left. */
export const CACHE_WARN_LEFT = 0.2;

export const toneOfShare = (share: number): "success" | "warning" | "error" => (share >= HOT_SHARE ? "error" : share >= WARN_SHARE ? "warning" : "success");

/** The cache's tone from the share of its life still left: green, amber from a fifth, red once expired. */
export const toneOfCache = (leftShare: number, isExpired: boolean): "success" | "warning" | "error" => (isExpired ? "error" : leftShare <= CACHE_WARN_LEFT ? "warning" : "success");

export const SEP = " \u{b7} ";
export const HINT_MARK = "\u{25b2}";
export const CACHE_MARK = "\u{29d7}";
/** Leads a red figure or word, so red is never the only signal. */
export const CRIT_MARK = "!";
const FULL = "\u{2588}";
const EMPTY = "\u{2591}";

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** A bar of `cells` characters, `share` of it filled. */
export function textBar(share: number, cells: number): string {
  const n = Math.max(0, Math.floor(cells));
  const filled = Math.round(clamp01(share) * n);
  return FULL.repeat(filled) + EMPTY.repeat(n - filled);
}

/** A bar of `cells` characters as its two runs, so the fill and the empty part take their own styles. */
export function barRuns(share: number, cells: number): { filled: string; empty: string } {
  const n = Math.max(0, Math.floor(cells));
  const filled = Math.round(clamp01(share) * n);
  return { filled: FULL.repeat(filled), empty: EMPTY.repeat(n - filled) };
}

/** The Text props that mark a selected choice: bold and underlined, the rest dim. */
export const selectedProps = (isSelected: boolean): Record<string, unknown> => (isSelected ? { weight: "bold", underline: true } : { dimColor: true });

/** SVG cannot take a theme key, so a bar's fill is a fixed colour per tone. */
export const BAR_FILL = { success: "#2e9e5b", warning: "#b7791f", error: "#d64545", accent: "#c96442", dim: "#6b7488", text: "#6b7488" } as const;

/** A rounded bar of `width` x `height` pixels, `share` of it filled in `tone`. */
export function svgBar(share: number, width: number, height: number, tone: Tone): string {
  const filled = Math.round(clamp01(share) * width);
  const r = Math.round(height / 4);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="${r}" fill="${BAR_FILL.dim}" fill-opacity="0.3"/>` +
    `<rect width="${filled}" height="${height}" rx="${r}" fill="${BAR_FILL[tone]}"/></svg>`
  );
}

const LEVELS = ["\u{2582}", "\u{2583}", "\u{2585}", "\u{2587}", "\u{2588}"];
const NONE = "\u{b7}";

/** One hour's glyph: its token total against the 5 rank bands [p30, p50, p70, p90, max]; zero is a dot. */
export function hourGlyph(tokens: number, bands: number[]): string {
  if (!(tokens > 0)) return NONE;
  const i = bands.findIndex((b) => tokens <= b);
  return LEVELS[i === -1 ? LEVELS.length - 1 : Math.min(i, LEVELS.length - 1)]!;
}

/** The last 8 hours as one glyph each, oldest first. */
export const chartText = (values: number[], bands: number[]): string => values.map((v) => hourGlyph(v, bands)).join("");

/** A Text's colour and weight for a tone. */
export function toneProps(tone: Tone | undefined, bold = false): Record<string, unknown> {
  const color = tone === "accent" ? "claude" : tone === "success" || tone === "warning" || tone === "error" ? tone : undefined;
  return { ...(color !== undefined && { color }), ...(bold && { weight: "bold" }), ...(tone === "dim" && { dimColor: true }) };
}

/** What tells the parts of a stacked bar apart: a glyph and a colour. Theme keys on the terminal, fixed fills in Svg. */
export const PART_COLORS = ["claude", "permission", "suggestion", "ide", "remember"] as const;
export const PART_FILLS = ["#c96442", "#7a6ff0", "#3b82c4", "#2a8f8f", "#b85a9a"] as const;
/** Full, dark, medium and light shade: four shapes, read without colour. A fifth part repeats a shape in its own colour. */
export const PART_GLYPHS = ["\u{2588}", "\u{2593}", "\u{2592}", "\u{2591}"] as const;

export const partColor = (i: number): (typeof PART_COLORS)[number] => PART_COLORS[i % PART_COLORS.length]!;
export const partGlyph = (i: number): (typeof PART_GLYPHS)[number] => PART_GLYPHS[i % PART_GLYPHS.length]!;

/** Cells for each part of a bar `cells` wide, in proportion to its share; every part above zero gets one at least, and they add up to `cells`. */
export function partCells(shares: number[], cells: number): number[] {
  const total = shares.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const n = Math.max(0, Math.floor(cells));
  if (total <= 0 || n === 0) return shares.map(() => 0);
  const out = shares.map((s) => (s > 0 ? Math.max(1, Math.round((s / total) * n)) : 0));
  // Rounding and the one-cell floor can overshoot or undershoot: settle the difference on the widest part.
  let diff = n - out.reduce((a, b) => a + b, 0);
  while (diff !== 0) {
    let at = 0;
    for (let i = 1; i < out.length; i++) if (out[i]! > out[at]!) at = i;
    if (diff < 0 && out[at]! <= 1) break;
    out[at] = out[at]! + (diff > 0 ? 1 : -1);
    diff += diff > 0 ? -1 : 1;
  }
  return out;
}

/** A rounded bar of `width` x `height` pixels cut into parts by `shares`, each in its fill. */
export function svgStack(shares: number[], width: number, height: number): string {
  const total = shares.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const r = Math.round(height / 4);
  let x = 0;
  const parts: string[] = [];
  shares.forEach((s, i) => {
    if (!(s > 0) || total <= 0) return;
    const w = Math.max(1, Math.round((s / total) * width));
    parts.push(`<rect x="${x}" width="${Math.min(w, width - x)}" height="${height}" fill="${PART_FILLS[i % PART_FILLS.length]}"/>`);
    x += w;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><clipPath id="c"><rect width="${width}" height="${height}" rx="${r}"/></clipPath><rect width="${width}" height="${height}" rx="${r}" fill="${BAR_FILL.dim}" fill-opacity="0.3"/><g clip-path="url(#c)">${parts.join("")}</g></svg>`;
}
