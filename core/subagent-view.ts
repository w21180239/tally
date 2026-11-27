// A sub-agent's transcript boiled down for a window: the task it was given, each tool call with what it was called
// on and how much came back, and its last words. Built row by row from the parser's output so a transcript of any
// size can be taken in chunks. Pure.
import type { Parsed } from "./types.ts";

/** One tool call: the tool, what it was called on in one line, and the characters of its result (null until one is seen). */
export type TranscriptCall = { tool: string; item: string; resultChars: number | null };

export type TranscriptView = {
  /** The first message the agent was given. */
  prompt: string;
  /** The latest calls, oldest first; the ones before them are only counted. */
  calls: TranscriptCall[];
  /** Calls in the whole transcript. */
  total: number;
  /** The agent's last text; empty while it has said none. */
  answer: string;
};

/** Calls kept in a view. */
export const KEEP_CALLS = 200;
/** A call's one-line text is cut to this many characters. */
export const ITEM_CHARS = 80;
/** The end of a transcript read for the agent's last words. */
export const TAIL_BYTES = 262_144;

/** `s` as one line of at most `max` characters. */
export function oneLine(s: string, max: number): string {
  const flat = s.slice(0, max * 4 + 64).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}\u{2026}` : flat;
}

export type TranscriptBuilder = {
  add(p: Parsed): void;
  /** The view so far, with `answer` as its last words. */
  view(answer: string): TranscriptView;
};

/** Collects a transcript's rows (any order within one agent's file is the file's own order). */
export function transcriptBuilder(keep = KEEP_CALLS): TranscriptBuilder {
  let prompt = "";
  let total = 0;
  const calls: TranscriptCall[] = [];
  const byId = new Map<string, TranscriptCall>();
  const seen = new Set<string>();
  const idOf = new Map<TranscriptCall, string>();
  return {
    add(p) {
      if (p.t === "user") {
        const u = p.row;
        if (u.kind === "prompt" && prompt === "" && total === 0) prompt = u.text ?? "";
        for (const r of u.results ?? []) {
          const call = byId.get(r.toolUseId);
          if (call !== undefined) call.resultChars = r.chars;
        }
        return;
      }
      if (p.t !== "usage") return;
      for (const t of p.row.tools) {
        // A request written as several lines repeats its tool calls.
        if (t.id !== undefined) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
        }
        total++;
        const call: TranscriptCall = { tool: t.name, item: oneLine(t.command ?? t.target ?? t.prompt ?? t.name, ITEM_CHARS), resultChars: null };
        calls.push(call);
        if (t.id !== undefined) {
          byId.set(t.id, call);
          idOf.set(call, t.id);
        }
        if (calls.length > keep) {
          const old = calls.shift()!;
          const id = idOf.get(old);
          if (id !== undefined) byId.delete(id);
          idOf.delete(old);
        }
      }
    },
    view: (answer) => ({ prompt, calls: [...calls], total, answer }),
  };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The last assistant text in `tail` (the end of a transcript); lines cut by the read's start are skipped. */
export function lastAnswer(tail: string): string {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    let l: unknown;
    try {
      l = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRec(l) || l.type !== "assistant" || !isRec(l.message) || !Array.isArray(l.message.content)) continue;
    const said = l.message.content
      .map((b: unknown) => (isRec(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("")
      .trim();
    if (said !== "") return said;
  }
  return "";
}
