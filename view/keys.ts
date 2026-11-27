// The tab bar's specs and the key line at the window's foot: only keys that work on the tab shown.
import type { TabId } from "../core/args.ts";
import type { Span } from "../core/summary.ts";

export type TabSpec = { tab: TabId; label: string; short: string; hotkey: string };

// Help takes 0, the key after 9.
export const TABS: readonly TabSpec[] = [
  { tab: "session", label: "Session", short: "Session", hotkey: "1" },
  { tab: "usage", label: "Usage", short: "Usage", hotkey: "2" },
  { tab: "context", label: "Context", short: "Context", hotkey: "3" },
  { tab: "history", label: "History", short: "History", hotkey: "4" },
  { tab: "hints", label: "Hints", short: "Hints", hotkey: "5" },
  { tab: "help", label: "Help", short: "Help", hotkey: "0" },
];

/** What the tab's body has on it now: each key below exists only while its Button is drawn. */
export type KeyCtx = {
  /** An agent list is shown: `a` opens it, `p`/`n` step through it. */
  agents?: boolean;
  /** `v` puts the chosen agent's transcript in view; `b` goes back. */
  canView?: boolean;
  canGoBack?: boolean;
  /** `v` shows the full text behind each row (Usage). */
  canFull?: boolean;
  /** `m` opens the cut lists. */
  more?: boolean;
  /** Tab and Enter walk and open rows; evidence is the Hints tab's form. */
  rows?: boolean;
  evidence?: boolean;
  /** A hint can be adopted with `y`. */
  adopt?: boolean;
  /** Totals of other computers exist (`syncDir` set): `t` switches this computer and all. */
  machines?: boolean;
};

/** Spans a tab switches with `s`, in cycle order; none means no span switch. */
export function spansOf(tab: TabId): Span[] {
  return tab === "usage" ? ["session", "24h", "30d"] : tab === "hints" ? ["24h", "30d"] : [];
}

/** True on the tabs that filter by repository with `r`. */
export const hasRepoSwitch = (tab: TabId): boolean => tab === "history" || tab === "hints";

/** The keys that work on `tab`, each as `key words`, in line order; Esc folds the window on every tab. */
export function keyLine(tab: TabId, ctx: KeyCtx = {}): string[] {
  const keys = ["0-5 switch tab"];
  if (spansOf(tab).length > 0) keys.push("s time span");
  if (hasRepoSwitch(tab)) keys.push("r repo filter");
  if (ctx.machines === true && (tab === "history" || tab === "hints")) keys.push("t computers");
  if (ctx.agents === true) keys.push("a agent list", "p/n prev/next");
  if (ctx.canView === true) keys.push("v open agent");
  if (ctx.canFull === true) keys.push("v full text");
  if (ctx.canGoBack === true) keys.push("b return");
  if (ctx.more === true) keys.push("m full lists");
  if (ctx.rows === true) keys.push("tab/enter open rows");
  if (ctx.evidence === true) keys.push("tab/enter show evidence");
  if (ctx.adopt === true) keys.push("y adopt");
  keys.push(ESC_WORDS);
  return keys;
}

/** What the key line says while the window does not hold the keys: ctrl+x, then tab. */
export const HOW_TO_FOCUS = "ctrl+x then tab to focus";
/** What the key line says while the window holds the keys, and how Esc reads there. */
export const KEYS_ACTIVE = "keys active";
export const ESC_WORDS = "esc collapse";

/** The keys in one dim row of `cols` cells: how to focus first, then whole entries while they fit. */
export function keyLineText(cols: number, isFocused: boolean, keys: string[]): string {
  let line = isFocused ? KEYS_ACTIVE : HOW_TO_FOCUS;
  for (const entry of keys) {
    if (line.length + 3 + entry.length > cols) break;
    line = `${line} \u{b7} ${entry}`;
  }
  return line;
}
