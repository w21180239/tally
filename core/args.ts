// Parses the text after `/tally`. Word order is free; unknown words are collected, never dropped.
import type { Span } from "./summary.ts";
import { dict } from "./dict.ts";
import { COERCE, SETTING_KEYS } from "./settings.ts";
import type { Settings } from "./settings.ts";

export type TabId = "session" | "usage" | "context" | "history" | "hints" | "help";
export type Sub = "report" | "debug" | "sync";

export type ParsedArgs = {
  set: Partial<Settings>;
  sub?: Sub;
  tab?: TabId;
  span?: Span;
  // `report` only: window in days and optional repo filter (case kept).
  days?: number;
  repo?: string;
  json?: boolean;
  unknown: string[];
};

const TABS: readonly string[] = ["session", "usage", "context", "history", "hints", "help"];
const SUBS: readonly string[] = ["report", "debug", "sync"];
const SPANS: readonly string[] = ["24h", "30d"];
const DAYS = /^(\d+)d?$/;

// Setting names are matched case-insensitively; `row` is the short form of desktopRow.
const KEY_BY_WORD = dict<keyof Settings>();
KEY_BY_WORD["row"] = "desktopRow";
for (const k of SETTING_KEYS) KEY_BY_WORD[k.toLowerCase()] = k;

type Token = { text: string; quoted: boolean };

// Whitespace-separated words. A word that starts with " or ' runs to the matching quote and keeps its
// text verbatim (backslashes included), so a path with spaces survives. An unterminated quote is plain text.
function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = input.indexOf(c, i + 1);
      if (end !== -1) {
        out.push({ text: input.slice(i + 1, end), quoted: true });
        i = end + 1;
        continue;
      }
    }
    let j = i;
    while (j < input.length && !/\s/.test(input[j]!)) j++;
    out.push({ text: input.slice(i, j), quoted: false });
    i = j;
  }
  return out;
}

export function parseArgs(input: string): ParsedArgs {
  const words = tokenize(input);
  const out: ParsedArgs = { set: {}, unknown: [] };
  const report = words.some((t) => !t.quoted && t.text.toLowerCase() === "report");
  const set = out.set as Record<string, unknown>;

  for (let i = 0; i < words.length; i++) {
    const { text: word, quoted } = words[i]!;
    if (quoted) {
      // A quoted word is data, never a keyword.
      if (report && out.repo === undefined) out.repo = word;
      else out.unknown.push(word);
      continue;
    }
    const w = word.toLowerCase();

    const key = KEY_BY_WORD[w];
    if (key) {
      const next = words[i + 1];
      const value = next === undefined ? undefined : COERCE[key](next.text);
      if (value === undefined) {
        out.unknown.push(word);
        continue;
      }
      set[key] = value;
      i++;
      continue;
    }
    if (SUBS.includes(w)) {
      out.sub = w as Sub;
      continue;
    }
    if (w === "--json") {
      out.json = true;
      continue;
    }
    if (report) {
      const m = DAYS.exec(w);
      if (m) {
        const n = Number(m[1]);
        if (n > 0) out.days = n;
        else out.unknown.push(word);
        continue;
      }
    }
    if (TABS.includes(w)) {
      out.tab = w as TabId;
      continue;
    }
    if (SPANS.includes(w)) {
      out.span = w as Span;
      continue;
    }
    if (report && out.repo === undefined && !word.startsWith("-")) {
      out.repo = word;
      continue;
    }
    out.unknown.push(word);
  }
  return out;
}
