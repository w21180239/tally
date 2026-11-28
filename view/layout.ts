// Which drawing the window uses at a width, and the size it asks to open at.
export type Placement = "dock" | "inline";
export type Layout = "compact" | "narrow" | "full" | "short";

export const COMPACT_COLUMNS = 40;
export const FULL_COLUMNS = 70;
/** An inline frame shorter than this draws the short view. */
export const SHORT_ROWS = 6;
/** The window's content is never drawn wider than this, docked or inline; it sits at the left. */
export const MAX_COLUMNS = 96;

/**
 * The dock size the window asks for: a request, the person's own size wins. The engine places an open nobody asked
 * for (session start) from 144 terminal columns, and one the person asked for from 110; below that it sits inline.
 */
export const OPEN_COLUMNS = 90;
export const OPEN_ROWS = 40;

/**
 * The drawing for a body `cols` wide and `rows` tall. An inline frame under SHORT_ROWS rows is the short view
 * whatever its width. Else the width alone picks: under 40 compact, 40 to 69 narrow, from 70 full.
 */
export function layoutOf(cols: number, rows: number, placement: Placement): Layout {
  if (placement === "inline" && rows < SHORT_ROWS) return "short";
  return cols < COMPACT_COLUMNS ? "compact" : cols < FULL_COLUMNS ? "narrow" : "full";
}
