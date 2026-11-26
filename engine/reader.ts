import { parseOversized, takeLines, utf8Length } from "../core/lines.ts";
import { parseLine } from "../core/parse.ts";
import type { FileCtx, Parsed } from "../core/types.ts";
import type { Slicer } from "./slicer.ts";

// The slice of `$` the reader uses; the real engine and tests/world.ts both fit.
export type ReaderEnv = { fs: { read(path: string, o: { offset: number; length: number }): Promise<string> } };

export type FileState = { size: number; mtimeMs: number; offset: number };

export const CHUNK = 4_194_304;
const EDGE = 65_536;

// Bytes of `text`'s first `n` chars, not counting U+FFFD from a cut character at the chunk start
// (up to 3 stray continuation bytes, 1 byte each in the file).
function bytesTo(text: string, n: number): number {
  let lead = 0;
  while (lead < 3 && lead < n && text.charCodeAt(lead) === 0xfffd) lead++;
  return utf8Length(text.slice(0, n)) - 2 * lead;
}

// Line longer than a chunk, starting at `start`: head and tail pieces plus the offset after its "\n".
// `end` is -1 when the file ends before a newline.
async function scanOversized(
  $: ReaderEnv,
  path: string,
  start: number,
  first: string,
  size: number,
  slicer: Slicer,
): Promise<{ head: string; tail: string; end: number }> {
  const head = first.slice(0, EDGE);
  let tail = first.slice(-EDGE);
  let pos = start + CHUNK;
  while (pos < size) {
    await slicer.check();
    const len = Math.min(CHUNK, size - pos);
    const text = await $.fs.read(path, { offset: pos, length: len });
    const nl = text.indexOf("\n");
    if (nl >= 0) {
      tail = (tail + text.slice(0, nl)).slice(-EDGE);
      return { head, tail, end: pos + bytesTo(text, nl + 1) };
    }
    tail = (tail + text).slice(-EDGE);
    pos += len;
  }
  return { head, tail, end: -1 };
}

/** Reads what a transcript gained since `prev`; sinks every parsed row. Offset rests on a line start. */
export async function readIncrement(
  $: ReaderEnv,
  path: string,
  prev: FileState | undefined,
  listed: { size: number; mtimeMs: number },
  ctx: FileCtx,
  sink: (p: Parsed) => void,
  slicer: Slicer,
): Promise<FileState> {
  if (prev && prev.size === listed.size && prev.mtimeMs === listed.mtimeMs) return prev;
  // Shrunk: start over; the caller drops the file's old rows.
  let offset = prev && listed.size >= prev.size ? prev.offset : 0;
  const { size } = listed;
  while (offset < size) {
    await slicer.check();
    const length = Math.min(CHUNK, size - offset);
    const chunk = await $.fs.read(path, { offset, length });
    const taken = takeLines(chunk);
    if (taken.consumed > 0) {
      for (const line of taken.lines) {
        if (line === "") continue;
        const p = parseLine(line, ctx);
        if (p) sink(p);
        await slicer.check();
      }
      offset += taken.consumed;
      continue;
    }
    // No newline: a short read reached EOF (unterminated last line); a full chunk is an oversized line.
    if (length < CHUNK) break;
    const { head, tail, end } = await scanOversized($, path, offset, chunk, size, slicer);
    if (end < 0) break;
    const raw = parseOversized(head, tail);
    if (raw) sink({ t: "usage", row: { ...raw, synthetic: false, thinkingChars: 0, replyChars: 0, tools: [] } });
    offset = end;
  }
  return { size: listed.size, mtimeMs: listed.mtimeMs, offset };
}
