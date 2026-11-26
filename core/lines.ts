import type { RawUsage } from "./types.ts";
import { tokensOf } from "./usage.ts";

// UTF-8 byte length by code point; no TextEncoder.
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

// Complete lines only; the text after the last "\n" is left for the next read.
export function takeLines(chunk: string): { lines: string[]; consumed: number; partial: boolean } {
  const end = chunk.lastIndexOf("\n");
  if (end < 0) return { lines: [], consumed: 0, partial: true };
  const head = chunk.slice(0, end + 1);
  const lines = head.slice(0, -1).split("\n");
  return { lines, consumed: utf8Length(head), partial: false };
}

const str = (s: string, key: string): string | undefined => {
  const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(s);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
};

// Balanced-brace slice of the last `"usage":{...}` in s.
function lastUsage(s: string): Record<string, any> | null {
  const at = s.lastIndexOf('"usage":{');
  if (at < 0) return null;
  const start = at + 8;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Single line over 4 MiB: pull each field from the first 64 KiB, then the last.
export function parseOversized(head: string, tail: string): RawUsage | null {
  const both = (k: string) => str(head, k) ?? str(tail, k);
  const u = lastUsage(head) ?? lastUsage(tail);
  const requestId = both("requestId");
  const sessionId = both("sessionId");
  const timestamp = both("timestamp");
  const model = both("model");
  if (!u || !requestId || !sessionId || !timestamp || !model) return null;
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return null;
  const cwd = both("cwd");
  return {
    requestId,
    sessionId,
    ts,
    model,
    tokens: tokensOf(u),
    fast: both("speed") === "fast",
    sidechain: (/"isSidechain":\s*(true|false)/.exec(head) ?? /"isSidechain":\s*(true|false)/.exec(tail))?.[1] === "true",
    ...(cwd ? { cwd } : {}),
  };
}
