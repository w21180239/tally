// Which drawing the window uses at a width, and the size it asks to open at.
export type Placement = "dock" | "inline";
export type Layout = "compact" | "narrow" | "full" | "short";

export const COMPACT_COLUMNS = 40;
export const FULL_COLUMNS = 70;
/** An inline frame shorter than this draws the short view. */
export const SHORT_ROWS = 10;

/** The dock size the window asks for: a request, the person's own size wins. */
export const OPEN_COLUMNS = 90;
export const OPEN_ROWS = 40;
/** Terminal columns from which the window opens by itself; under it, it starts folded. */
export const AUTO_OPEN_COLUMNS = 144;
/** Terminal columns from which a pane docks beside the transcript; under it, it sits inline. */
export const DOCK_COLUMNS = 110;

export const canDock = (columns: number): boolean => columns >= DOCK_COLUMNS;
export const opensByItself = (columns: number): boolean => columns >= AUTO_OPEN_COLUMNS;

/**
 * The drawing for a body `cols` wide and `rows` tall. Inline, a frame under SHORT_ROWS rows is the short
 * view whatever its width, and so is any inline frame on a fullscreen terminal too narrow to dock
 * (`isFullscreen`). Else the width alone picks: under 40 compact, 40 to 69 narrow, from 70 full.
 */
export function layoutOf(cols: number, rows: number, placement: Placement, opts: { isFullscreen?: boolean } = {}): Layout {
  if (placement === "inline" && (rows < SHORT_ROWS || opts.isFullscreen === true)) return "short";
  return cols < COMPACT_COLUMNS ? "compact" : cols < FULL_COLUMNS ? "narrow" : "full";
}
