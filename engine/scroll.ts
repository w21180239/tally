// A docked tab's scrolling. The drawing windows its own rows under a sticky head and foot, so the engine's `ui.scroll`
// (wheel, PgUp/PgDn, arrows, Home/End while the pane holds the keys) is answered here: move the window, draw again.
import type { On } from "claude-code";
import { moveLines, movePage } from "../view/scroll.ts";
import { PANE_ID, logIssue, readView, setScroll } from "./window.ts";

/** What the last docked draw knew about its rows: set at each draw, read by the scroll hook. */
export type ScrollMetrics = {
  /** The tab overflows its dock, so the window is ours to move; else the engine's own handling stands. */
  active: boolean;
  heights: number[];
  capacity: number;
  maxOffset: number;
};

const IDLE: ScrollMetrics = { active: false, heights: [], capacity: 0, maxOffset: 0 };
let metrics: ScrollMetrics = IDLE;

export function noteMetrics(m: ScrollMetrics): void {
  metrics = m;
}

/** Lines one wheel notch moves. */
export const WHEEL_LINES = 3;

/** The window start after the engine's move `by` (signed rows); a move of the pane's height or more is a page. */
export function targetOffset(m: ScrollMetrics, from: number, by: number, bodyRows: number, isWheel: boolean): number {
  if (by === 0) return Math.min(Math.max(0, from), m.maxOffset);
  if (!isWheel && Math.abs(by) >= Math.max(2, bodyRows)) return movePage(m.heights, m.capacity, from, m.maxOffset, by > 0 ? 1 : -1);
  return moveLines(m.heights, from, isWheel ? by * WHEEL_LINES : by, m.maxOffset);
}

/** Registers the scroll hook; the only `on("ui.scroll")` of the module. */
export function wireScroll(on: On): void {
  on("ui.scroll", { component: "Pane", requestId: PANE_ID }, async ($, e, next) => {
    if (!metrics.active || e.origin.kind !== "person") return next(e);
    try {
      const view = await readView($);
      await setScroll($, targetOffset(metrics, view.scroll, e.by, e.bodyRows, e.pointer !== undefined));
      $.ui.invalidate("ui.render");
    } catch (err) {
      logIssue($, err);
    }
    return {};
  });
}
