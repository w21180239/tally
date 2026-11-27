// Condenses a sub-agent's transcript for the window: its opening prompt, one line per tool call (target and result
// size) and what it wrote last. Fed one parsed row at a time, so a file of any size goes through in chunks. Pure.
import type { Parsed } from "./types.ts";

/** A tool call as listed: tool name, a one-line target, and result size in characters (null while no result has arrived). */
export type TranscriptCall = { tool: string; item: string; resultChars: number | null };

export type TranscriptView = {
  /** The agent's opening prompt. */
  prompt: string;
  /** The newest calls, oldest first; earlier ones are only counted. */
  calls: TranscriptCall[];
  /** Number of calls in the whole transcript. */
  total: number;
  /** What the agent last wrote as prose; empty if it has written none. */
  answer: string;
};

/** Calls kept in a view. */
export const KEEP_CALLS = 200;
/** A call's one-line text is cut to this many characters. */
export const ITEM_CHARS = 80;
/** The end of a transcript read for the agent's last words. */
export const TAIL_BYTES = 262_144;

/** Characters of a string looked at when making it one line. */
const SCAN_CHARS = 2048;

/** `s` on one line: runs of whitespace become one space, the ends are trimmed, and anything past `max` is replaced by an ellipsis. */
export function oneLine(s: string, max: number): string {
  let out = "";
  let gap = false;
  for (const ch of s.slice(0, SCAN_CHARS)) {
    if (ch.trim() === "") {
      gap = out !== "";
      continue;
    }
    out += gap ? ` ${ch}` : ch;
    gap = false;
    if (out.length > max) return `${out.slice(0, Math.max(0, max - 1))}\u{2026}`;
  }
  return out;
}

export type TranscriptBuilder = {
  add(p: Parsed): void;
  /** The view so far, with `answer` as its last words. */
  view(answer: string): TranscriptView;
};

/** Collects a transcript's rows (any order within one agent's file is the file's own order). */
export function transcriptBuilder(keep = KEEP_CALLS): TranscriptBuilder {
  let prompt = "";
  let promptTaken = false;
  let total = 0;
  const calls: TranscriptCall[] = [];
  const byId = new Map<string, TranscriptCall>();
  const seen = new Set<string>();
  const idOf = new Map<TranscriptCall, string>();
  return {
    add(p) {
      if (p.t === "user") {
        const u = p.row;
        if (u.kind === "prompt" && !promptTaken) {
          promptTaken = true;
          prompt = u.text ?? "";
        }
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
