// Tones, glyphs and the two bar drawings (text and Svg) shared by every view. Non-ASCII glyphs are escapes.

export type Tone = "success" | "warning" | "error" | "accent" | "dim";

/** Used-share thresholds: a figure is amber from half and red from 80%. */
export const WARN_SHARE = 0.5;
export const HOT_SHARE = 0.8;

export const toneOfShare = (share: number): "success" | "warning" | "error" => (share >= HOT_SHARE ? "error" : share >= WARN_SHARE ? "warning" : "success");

export const SEP = " \u{b7} ";
export const HINT_MARK = "\u{25b2}";
export const CACHE_MARK = "\u{29d7}";
const FULL = "\u{2588}";
const EMPTY = "\u{2591}";

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** A bar of `cells` characters, `share` of it filled. */
export function textBar(share: number, cells: number): string {
  const n = Math.max(0, Math.floor(cells));
  const filled = Math.round(clamp01(share) * n);
  return FULL.repeat(filled) + EMPTY.repeat(n - filled);
}

/** SVG cannot take a theme key, so a bar's fill is a fixed colour per tone. */
export const BAR_FILL = { success: "#2e9e5b", warning: "#d99a1e", error: "#d64545", accent: "#c96442", dim: "#9aa3b2" } as const;

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
