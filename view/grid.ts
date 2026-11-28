// The one column grid every row of the window shares: `lead | label (flexible) | tokens | money | bar`, a cell apart,
// the figures right-aligned. A tab declares which columns it has; the width decides which of them fit. The bar
// column is always reserved while it is on, so a row without a bar keeps the figures where they are.

export const TOKEN_CELLS = 7;
export const MONEY_CELLS = 8;
export const BAR_CELLS = 8;
/** Under COMPACT_COLS the bar is two cells narrower. */
export const COMPACT_BAR_CELLS = 6;
export const COMPACT_COLS = 40;
export const COLUMN_GAP = 1;
/** A label is never given less than this; a column that would take it below is dropped. */
export const LABEL_MIN = 12;
/** A tab with money and tokens shows both from this width; narrower it shows money alone. */
export const TOKENS_FROM = 52;
/** One cell is this many pixels on a surface that draws bars as Svg. */
export const SVG_CELL_PX = 8;
export const SVG_BAR_H = 8;
/** A sub-item is indented by this many cells. */
export const INDENT = 2;

/** The key or name column of a definition row (Help's keys, a hint's `Do`), and the widths the tabs use. */
export const TERM_SHORT = 4;
export const TERM_KEYS = 12;

export type Want = {
  tokens?: boolean;
  money?: boolean;
  bar?: boolean;
  /** Width of a fixed leading column (the foot's labels). */
  lead?: number;
  /** A wider figure column than MONEY_CELLS, for a figure with a word before it (`save ~$0.03`) or a setting's value. */
  moneyCells?: number;
};

/** Widths in cells; 0 is a column that is off. `label` is what is left for the label text. */
export type Grid = { cols: number; lead: number; label: number; tokens: number; money: number; bar: number };

const taken = (g: Pick<Grid, "lead" | "tokens" | "money" | "bar">): number => [g.lead, g.tokens, g.money, g.bar].reduce((n, w) => n + (w > 0 ? w + COLUMN_GAP : 0), 0);

/** The grid for a body `cols` wide. The label gets what the columns leave; if that is under LABEL_MIN the bar, then the tokens, go. */
export function gridOf(cols: number, want: Want = {}): Grid {
  const width = Math.max(0, Math.floor(cols));
  const g = {
    lead: want.lead ?? 0,
    tokens: want.tokens === true && (want.money !== true || width >= TOKENS_FROM) ? TOKEN_CELLS : 0,
    money: want.money === true ? (want.moneyCells ?? MONEY_CELLS) : 0,
    bar: want.bar === true ? (width < COMPACT_COLS ? COMPACT_BAR_CELLS : BAR_CELLS) : 0,
  };
  if (width - taken(g) < LABEL_MIN) g.bar = 0;
  if (width - taken(g) < LABEL_MIN && g.money > 0) g.tokens = 0;
  return { cols: width, ...g, label: Math.max(0, width - taken(g)) };
}

/** `s` cut to `width` cells, with an ellipsis when it was longer. */
export const cut = (s: string, width: number): string => (s.length <= width ? s : width <= 0 ? "" : width === 1 ? "\u{2026}" : `${s.slice(0, width - 1)}\u{2026}`);

/** A figure cell: `~` before the figure marks an estimate, the whole right-aligned in `width` cells. */
export const figureCell = (value: string | undefined, isEstimate: boolean, width: number): string => (value === undefined || value === "" ? "" : cut(`${isEstimate ? "~" : ""}${value}`, width));

/**
 * What a section title's label column holds: the name, a dim note while there is room, a dim rule to the edge.
 * A cell sits between the parts, so name + note + rule and their gaps add up to `width`.
 */
export function titleParts(name: string, note: string | undefined, width: number): { name: string; note: string; rule: string } {
  const shown = cut(name, width);
  let room = width - shown.length;
  let noteText = "";
  // The note keeps at least a short rule after it: gap, 3 note cells, gap, 2 rule cells.
  if (note !== undefined && note !== "" && room >= 7) {
    noteText = cut(note, room - 4);
    room -= noteText.length + 1;
  }
  const rule = room >= 3 ? "\u{2500}".repeat(room - 1) : "";
  return { name: shown, note: noteText, rule };
}

export type RowText = { lead?: string; label: string; tokens?: string; money?: string; est?: boolean; share?: number | null };

/** A row as plain text in `g`: what the cells say, for tests and plain copies. Bars are drawn with `bar`. */
export function rowLine(g: Grid, r: RowText, bar: (share: number, cells: number) => string): string {
  const parts: string[] = [];
  if (g.lead > 0) parts.push(cut(r.lead ?? "", g.lead).padEnd(g.lead));
  parts.push(cut(r.label, g.label).padEnd(g.label));
  if (g.tokens > 0) parts.push(figureCell(r.tokens, r.est === true, g.tokens).padStart(g.tokens));
  if (g.money > 0) parts.push(figureCell(r.money, r.est === true, g.money).padStart(g.money));
  if (g.bar > 0) parts.push(r.share === undefined || r.share === null ? " ".repeat(g.bar) : bar(r.share, g.bar));
  return parts.join(" ");
}
