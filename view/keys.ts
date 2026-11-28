// The tab bar's specs and the key line at the window's foot: only keys that work on the tab shown.
import type { TabId } from "../core/args.ts";
import type { Span } from "../core/summary.ts";

export type TabSpec = { tab: TabId; label: string; short: string; hotkey: string };

// Help takes 0, the key after 9.
export const TABS: readonly TabSpec[] = [
  { tab: "session", label: "Session", short: "Session", hotkey: "1" },
  { tab: "usage", label: "Tokens", short: "Tokens", hotkey: "2" },
  { tab: "context", label: "Context", short: "Context", hotkey: "3" },
  { tab: "history", label: "Spend", short: "Spend", hotkey: "4" },
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
  /** `v` shows the full text behind each row (Tokens). */
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

/** Spans a tab switches with `s`, in cycle order; none means no span switch. Tokens, Spend and Hints share one span. */
export function spansOf(tab: TabId): Span[] {
  return tab === "usage" || tab === "history" ? ["session", "24h", "30d"] : tab === "hints" ? ["24h", "30d"] : [];
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
export const ESC_WORDS = "esc fold";
/** The same entry as the short view says it. */
export const ESC_FOLD = ESC_WORDS;

// How the line spells each entry of `keyLine`: the key, then one or two dim words. Entries not listed keep their words.
const SPELLED: Record<string, string> = {
  "0-5 switch tab": "1-5,0 tab",
  "s time span": "s span",
  "r repo filter": "r repo",
  "a agent list": "a agents",
  "v open agent": "v open",
  "v full text": "v text",
  "b return": "b back",
  "m full lists": "m more",
  "tab/enter open rows": "tab/enter open",
  "tab/enter show evidence": "tab/enter evidence",
};

/** One run of the key line: a key name (drawn bold) or the words and separators around it (drawn dim). */
export type KeyRun = { text: string; role: "key" | "dim" };

const GROUP_SEP = " \u{2503} ";
const PAIR_SEP = "  ";

const runsOf = (entry: string): KeyRun[] => {
  const spelled = SPELLED[entry] ?? entry;
  const at = spelled.indexOf(" ");
  return at < 0 ? [{ text: spelled, role: "key" }] : [{ text: spelled.slice(0, at), role: "key" }, { text: spelled.slice(at), role: "dim" }];
};
const widthOfRuns = (runs: KeyRun[]): number => runs.reduce((n, r) => n + r.text.length, 0);

/**
 * The key line in `cols` cells as runs: how to focus (or `keys active`) first, then this tab's own keys, a divider,
 * and the global pair (`1-5,0 tab`, `esc fold`). When the width falls, keys drop by priority: `esc` first, then this
 * tab's own keys from the last, and the tab switch last; an entry is shown whole or not at all.
 */
export function keyLineRuns(cols: number, isFocused: boolean, keys: string[]): KeyRun[] {
  const lead: KeyRun = { text: isFocused ? KEYS_ACTIVE : HOW_TO_FOCUS, role: "dim" };
  const switchEntry = keys[0];
  const escEntry = keys.length > 1 ? keys[keys.length - 1] : undefined;
  const own = keys.slice(1, escEntry === undefined ? undefined : -1);
  // Candidates in the order they are kept: the tab switch, the tab's keys left to right, then esc.
  const order: Array<{ entry: string; group: "own" | "global" }> = [
    ...(switchEntry === undefined ? [] : [{ entry: switchEntry, group: "global" as const }]),
    ...own.map((entry) => ({ entry, group: "own" as const })),
    ...(escEntry === undefined ? [] : [{ entry: escEntry, group: "global" as const }]),
  ];
  const kept: typeof order = [];
  const compose = (list: typeof order): KeyRun[] => {
    const ownRuns = list.filter((c) => c.group === "own").map((c) => runsOf(c.entry));
    const globalRuns = list.filter((c) => c.group === "global").map((c) => runsOf(c.entry));
    // The global pair reads `1-5,0 tab  esc fold`: the switch first, esc after it.
    const join = (rows: KeyRun[][]): KeyRun[] => rows.flatMap((r, i) => (i === 0 ? r : [{ text: PAIR_SEP, role: "dim" as const }, ...r]));
    const groups = [join(ownRuns), join(globalRuns)].filter((g) => g.length > 0);
    const body = groups.flatMap((g, i) => (i === 0 ? g : [{ text: GROUP_SEP, role: "dim" as const }, ...g]));
    return body.length === 0 ? [lead] : [lead, { text: SEP_DOT, role: "dim" }, ...body];
  };
  for (const candidate of order) {
    if (widthOfRuns(compose([...kept, candidate])) > cols) break;
    kept.push(candidate);
  }
  return compose(kept);
}

const SEP_DOT = " \u{b7} ";

/** The key line as one string; what `keyLineRuns` draws. */
export function keyLineText(cols: number, isFocused: boolean, keys: string[]): string {
  return keyLineRuns(cols, isFocused, keys)
    .map((r) => r.text)
    .join("");
}
