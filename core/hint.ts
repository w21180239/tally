// Hints: what a rule found, what it is worth and the evidence behind it. A rule reads one scope's figures and
// returns zero or more hints; `runRules` ranks them. `redact` strips an evidence row for display or for a report.
import { baseName } from "./path.ts";
import type { Summary } from "./summary.ts";

export type EvidenceKind = "command" | "path" | "title" | "text";

/** A fact behind a hint. `label` is fixed wording from the rule; `detail` is the variable content that `redact` strips. */
export type Evidence = { label: string; detail: string; kind: EvidenceKind };

export type Hint = {
  /** The rule's id, stable across runs: it names the hint in open rows and in adoption records. */
  rule: string;
  title: string;
  usd: number;
  summary: string;
  action: string;
  evidence: Evidence[];
  /** Compact wording for tight surfaces: the fold line and the narrow card. */
  short: string;
  confidence?: "high" | "low";
  /** A before-and-after figure the rule can measure again later. */
  metric?: { name: string; value: number };
};

/** What a rule sees: the live session's figures (`session`) or those of the chosen span and repos (`span`). */
export type HintInput = { scope: "session" | "span"; summary: Summary; nowMs: number };

export type HintRule = { id: string; run: (input: HintInput) => Hint[] };

/** Costliest first; equal amounts by rule id, so the order never depends on registration order. */
export const sortHints = (hints: Hint[]): Hint[] => [...hints].sort((a, b) => b.usd - a.usd || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));

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

// A command word that is an assignment; its value may hold quoted runs with spaces. Needs a space or the end after it.
const ENV_WORD = /^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"'])*(?:\s+|$)/;
const QUOTED_WORD = /^(["'])(.*?)\1/;

// The program a command line runs: past leading VAR=value words, unquoted, without its folder. Fails closed: when what
// is left is no plain program word (only assignments, an open quote, a stray `=`), the answer is "".
function programOf(command: string): string {
  let rest = command.trim();
  for (let m = ENV_WORD.exec(rest); m !== null; m = ENV_WORD.exec(rest)) rest = rest.slice(m[0].length);
  const quoted = QUOTED_WORD.exec(rest);
  const word = quoted !== null ? quoted[2]! : (rest.split(/[\s|;&]/, 1)[0] ?? "");
  return /["'=]/.test(word) ? "" : baseName(word);
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

const PLACEHOLDER_HINTS = 3;

// Stands in until the real rules land (Task 6.x), so the tab has something to draw: one hint per costliest session.
export const PLACEHOLDER_RULE: HintRule = {
  id: "placeholder",
  run: ({ summary }) =>
    summary.topSessions.slice(0, PLACEHOLDER_HINTS).map((s) => ({
      rule: `placeholder-${s.sessionId}`,
      title: `Placeholder hint for ${s.repo}`,
      usd: s.usd,
      summary: "A stand-in finding: this session is among the costliest.",
      action: "No action yet; real rules replace this one.",
      evidence: [
        ...(s.title === undefined || s.title === "" ? [] : [{ label: "Session", detail: s.title, kind: "title" as const }]),
        { label: "Resume", detail: s.resume, kind: "command" as const },
        { label: "First request", detail: new Date(s.started).toISOString().slice(0, 10), kind: "text" as const },
      ],
      short: "placeholder",
    })),
};

/** The registered rules; the engine runs whatever this holds. Real rules are added here and the placeholder dropped. */
export const HINT_RULES: HintRule[] = [PLACEHOLDER_RULE];
