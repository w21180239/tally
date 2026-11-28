// What a `full` machine file adds beyond the index, taken from what the tabs last built: nothing here runs the rules
// engine. Kept apart from engine/sync.ts because the History build imports that file.
import type { EngineInterface } from "claude-code";
import type { Extra } from "../core/sync.ts";
import { readHints } from "./hints-view.ts";
import { readHistory } from "./history-view.ts";

/** The 30-day, all-repo hints and the context fill, when their tabs have built them. */
export async function syncExtra($: EngineInterface): Promise<Extra> {
  const extra: Extra = {};
  const hints = await readHints($);
  if (hints.failure === undefined && hints.key.startsWith("30d|all|")) extra.hints = hints.span;
  const history = await readHistory($);
  if (history.failure === undefined && history.key.startsWith("all") && !history.key.includes("@") && history.fill.length > 0) {
    const fill: Record<string, number> = {};
    for (const f of history.fill) fill[f.tool] = f.tokens;
    extra.toolFill = fill;
  }
  return extra;
}
