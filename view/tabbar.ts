// The tab bar's faces for the width the body has: on the terminal one row always, by taking shorter names and a
// shorter fold button as the width falls; the Hints face carries the session's hint count.
import type { TabId } from "../core/args.ts";
import { TABS } from "./keys.ts";

export type TabFaces = {
  /** The text on each tab's button, in `TABS` order. */
  faces: Record<TabId, string>;
  /** The fold button's text; empty when no room is left for it. */
  fold: string;
};

const SHORT: Record<TabId, string> = { session: "Sess", usage: "Toks", context: "Ctx", history: "Spend", hints: "Hints", help: "Help" };
const TINY: Record<TabId, string> = { session: "Ses", usage: "Tok", context: "Ctx", history: "Spn", hints: "Hnt", help: "Hlp" };
const NANO: Record<TabId, string> = { session: "Se", usage: "To", context: "Cx", history: "Sp", hints: "Hn", help: "Hl" };

const FOLD_FULL = "\u{00d7} fold";
const FOLD_SHORT = "\u{00d7}";

/** The count shown on the Hints face: none for no hints. */
const counted = (name: string, count: number): string => (count > 0 ? `${name}(${count})` : name);

// A plain terminal button is `key: text`; buttons sit one cell apart.
function widthOf(faces: Record<TabId, string>, fold: string): number {
  const tabs = TABS.reduce((n, t) => n + t.hotkey.length + 2 + faces[t.tab].length, 0);
  return tabs + (TABS.length - 1) + (fold === "" ? 0 : 1 + fold.length);
}

/** The faces for `cols` cells with `count` hints: the first set that fits one row, else the smallest. */
export function tabFaces(cols: number, count: number): TabFaces {
  const names = (set: Record<TabId, string>): Record<TabId, string> => ({ ...set, hints: counted(set.hints, count) });
  const full = names({ session: "Session", usage: "Tokens", context: "Context", history: "Spend", hints: "Hints", help: "Help" });
  const tries: Array<[Record<TabId, string>, string]> = [
    [full, FOLD_FULL],
    [full, FOLD_SHORT],
    [names(SHORT), FOLD_SHORT],
    [names(TINY), FOLD_SHORT],
    [names(NANO), FOLD_SHORT],
    [names(NANO), ""],
  ];
  for (const [faces, fold] of tries) if (widthOf(faces, fold) <= cols) return { faces, fold };
  const [faces, fold] = tries[tries.length - 1]!;
  return { faces, fold };
}
