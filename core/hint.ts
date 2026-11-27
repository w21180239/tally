// Hints: what a rule found, what it is worth and the evidence behind it. A rule reads one scope's figures and
// returns zero or more hints; `runRules` ranks them. `redact` strips an evidence row for display or for a report.
import type { BreakdownSnapshot } from "./breakdown.ts";
import type { LiveState } from "./live-state.ts";
import { baseName } from "./path.ts";
import type { InstalledPlugin } from "./plugins.ts";
import type { PriceTable } from "./pricing.ts";
import { ALL_RULES } from "./rules/index.ts";
import type { Summary } from "./summary.ts";

export type EvidenceKind = "command" | "path" | "title" | "text";

/** A fact behind a hint. `label` is fixed wording from the rule; `detail` is the variable content that `redact` strips. */
export type Evidence = { label: string; detail: string; kind: EvidenceKind };

export type Hint = {
  /** The rule's id, stable across runs: it names the hint in open rows and in adoption records. */
  rule: string;
  title: string;
  /** Dollars at stake over the scope's span: what acting could save, or what the pattern costs when a rule has no price for the saving. 0 when no figure applies. */
  usd: number;
  /** Sorted ahead of every amount: the finding is about now (a limit close to running out). */
  urgent?: true;
  /** `usd` is an estimate of a saving under a stated what-if (a cheaper model, no fast mode), not billed spend. */
  projected?: true;
  summary: string;
  action: string;
  evidence: Evidence[];
  /** Compact wording for tight surfaces: the fold line and the narrow card. */
  short: string;
  confidence?: "high" | "low";
  /** A before-and-after figure the rule can measure again later. */
  metric?: { name: string; value: number };
};

/** One rate-limit window: percent used (0 to 100) and, when the host reports it, the reset time (epoch ms). */
export type LimitWindow = { percentUsed: number; resetsAt?: number };
export type RuleLimits = { fiveHour?: LimitWindow; sevenDay?: LimitWindow };

/**
 * What a rule sees: the live session's figures (`session`) or those of the chosen span and repos (`span`), the
 * breakdown snapshots, the installed plugins, the last known limits, the prices and the clock. `window` is the model's context size
 * in tokens when the engine reported it; rules assume 1M otherwise.
 */
export type HintInput = {
  scope: "session" | "span";
  summary: Summary;
  live?: LiveState;
  snaps: BreakdownSnapshot[];
  plugins: InstalledPlugin[];
  limits?: RuleLimits;
  prices: PriceTable;
  window?: number;
  nowMs: number;
};

/** `run` returns the rule's hints; `metric` is the figure an adopted hint is later checked against (see `Hint.metric`). */
export type HintRule = { id: string; run: (input: HintInput) => Hint[]; metric?: (input: HintInput) => number };

/** Urgent hints first, then costliest first; equal amounts by rule id, so the order never depends on registration order. */
export const sortHints = (hints: Hint[]): Hint[] => [...hints].sort((a, b) => Number(b.urgent === true) - Number(a.urgent === true) || b.usd - a.usd || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));

/** Awaited between rules so a long list never holds one slice; the engine passes its own, the default does not wait. */
export type Tick = () => Promise<void>;
const NO_TICK: Tick = () => Promise.resolve();

/** Every rule over `input`, ranked, one hint per rule id (the costlier one). A rule that throws is skipped so the others still show. */
export async function runRules(rules: readonly HintRule[], input: HintInput, tick: Tick = NO_TICK): Promise<Hint[]> {
  const best = new Map<string, Hint>();
  for (const rule of rules) {
    try {
      for (const h of rule.run(input)) {
        const seen = best.get(h.rule);
        if (seen === undefined || h.usd > seen.usd) best.set(h.rule, h);
      }
    } catch {
      /* one broken rule must not blank the tab */
    }
    await tick();
  }
  return sortHints([...best.values()]);
}

// A leading VAR=value word; the value may hold quoted runs with spaces. An escape, `$(` or a backtick makes it no match.
const ENV_WORD = /^[A-Za-z_]\w*=(?:"(?:[^"\\`$]|\$(?!\())*"|'[^']*'|[^\s"'\\`$]|\$(?!\())*(?:\s+|$)/;
const QUOTED_WORD = /^(["'])(.*?)\1/;
const WORD_END = /[\s|;&]/;
const SAFE_NAME = /^[\w.][\w.+@:~-]*$/;
// Wrappers whose own flags and assignments are skipped to reach the real program; any other flag shows nothing.
const WRAPPERS: Record<string, RegExp> = { sudo: /^-[EHnSbkKA]+$/, env: /^-i$/ };
const MAX_WRAPPERS = 3;

// The first word of `rest` as a bare command name plus the text after it; null for anything odd.
function firstWord(rest: string): { name: string; after: string } | null {
  const q = QUOTED_WORD.exec(rest);
  let raw: string;
  let after: string;
  if (q !== null) {
    raw = q[2]!;
    after = rest.slice(q[0].length);
  } else {
    const end = rest.search(WORD_END);
    raw = end < 0 ? rest : rest.slice(0, end);
    after = end < 0 ? "" : rest.slice(end);
    if (raw.endsWith("\\") && /^\s/.test(after)) return null;
  }
  if (after !== "" && !WORD_END.test(after[0]!)) return null;
  const name = baseName(raw);
  return SAFE_NAME.test(name) ? { name, after } : null;
}

// The program a command line runs: past leading VAR=value words and sudo/env wrappers, unquoted, without its folder.
// Fails closed: any word that is no ordinary command name (assignments only, an open quote, `$(`, redirects) gives "".
function programOf(command: string): string {
  let rest = command.trim();
  for (let depth = 0; depth <= MAX_WRAPPERS; depth++) {
    for (let m = ENV_WORD.exec(rest); m !== null; m = ENV_WORD.exec(rest)) rest = rest.slice(m[0].length);
    const w = firstWord(rest);
    if (w === null) return "";
    const flags = WRAPPERS[w.name];
    if (flags === undefined) return w.name;
    rest = w.after.trimStart();
    for (;;) {
      const flag = /^\S+/.exec(rest)?.[0];
      if (flag === undefined || !flags.test(flag)) break;
      rest = rest.slice(flag.length).trimStart();
    }
  }
  return "";
}

/** With `on`, the row keeps only what is safe to show: a command its program, a path its file name, a title nothing. */
export function redact(e: Evidence, on: boolean): Evidence {
  if (!on) return e;
  switch (e.kind) {
    case "command":
      return { ...e, detail: programOf(e.detail) };
    case "path":
      return { ...e, detail: baseName(e.detail) };
    case "title":
      return { ...e, detail: "" };
    default:
      return e;
  }
}

/** The registered rules; the engine runs whatever this holds. */
export const HINT_RULES: HintRule[] = ALL_RULES;
