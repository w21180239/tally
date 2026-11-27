// Parses the text after `/tally`. Word order is free; unknown words are collected, never dropped.
import type { Span } from "./summary.ts";
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
const KEY_BY_WORD: Record<string, keyof Settings> = { row: "desktopRow" };
for (const k of SETTING_KEYS) KEY_BY_WORD[k.toLowerCase()] = k;

export function parseArgs(input: string): ParsedArgs {
  const words = input.split(/\s+/).filter(Boolean);
  const out: ParsedArgs = { set: {}, unknown: [] };
  const report = words.some((w) => w.toLowerCase() === "report");
  const set = out.set as Record<string, unknown>;

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const w = word.toLowerCase();

    const key = KEY_BY_WORD[w];
    if (key) {
      const value = words[i + 1] === undefined ? undefined : COERCE[key](words[i + 1]);
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
