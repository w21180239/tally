import type { FsReadCall } from "claude-code";
import { parseOversized, takeLines, utf8Length } from "../core/lines.ts";
import { parseLine } from "../core/parse.ts";
import type { FileCtx, Parsed } from "../core/types.ts";
import type { Slicer } from "./slicer.ts";

// The slice of `$` the reader uses; the real plugin `$` (FsReadCall overloads) and tests/world.ts both fit.
export type ReaderEnv = { fs: { read: FsReadCall } };

export type FileState = { size: number; mtimeMs: number; offset: number };

export const CHUNK = 4_194_304;
const EDGE = 65_536;
const FFFD = String.fromCharCode(0xfffd);

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map<string, number>([...B64].map((c, i) => [c, i]));

// Offset of the first (or last) 0x0A in bytes [lo, hi) of the file; -1 when none.
// Pure-JS base64 decode; only a few bytes are ever read this way.
async function newlineAt($: ReaderEnv, path: string, lo: number, hi: number, last: boolean): Promise<number> {
  const { base64 } = await $.fs.read(path, { as: "bytes", offset: lo, length: hi - lo });
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of base64) {
    const v = B64_INDEX.get(c);
    if (v === undefined) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  const at = last ? bytes.lastIndexOf(10) : bytes.indexOf(10);
  return at < 0 ? -1 : lo + at;
}

// Chunk text decodes invalid or cut bytes to U+FFFD (1-3 bytes in the file), so utf8Length over
// such text can overshoot by up to 2 bytes per U+FFFD. Offsets must land on a line start or the
// next line parses from mid-line. Clean text has exact lengths; text with a U+FFFD is re-anchored
// to the real "\n" byte with a read of at most 2k+1 bytes (k = U+FFFD count).
const countFffd = (s: string): number => s.split(FFFD).length - 1;

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
      const est = utf8Length(text.slice(0, nl + 1));
      const k = countFffd(text.slice(0, nl));
      let end = pos + est;
      if (k > 0) {
        const hi = Math.min(pos + est, pos + len);
        const at = await newlineAt($, path, Math.max(pos, hi - 2 * k - 1), hi, false);
        if (at >= 0) end = at + 1;
      }
      return { head, tail, end };
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
      let consumed = taken.consumed;
      const k = countFffd(chunk.slice(0, chunk.lastIndexOf("\n")));
      if (k > 0) {
        const hi = Math.min(offset + consumed, offset + length);
        const at = await newlineAt($, path, Math.max(offset, hi - 2 * k - 1), hi, true);
        if (at >= 0) consumed = at + 1 - offset;
      }
      offset += consumed;
      continue;
    }
    // No newline: a short read reached EOF (unterminated last line); a full chunk is an oversized line.
    if (length < CHUNK) break;
    const { head, tail, end } = await scanOversized($, path, offset, chunk, size, slicer);
    if (end < 0) break;
    // Oversized lines that are not usage rows are dropped (controller ruling).
    const raw = parseOversized(head, tail);
    if (raw) sink({ t: "usage", row: { ...raw, synthetic: false, thinkingChars: 0, replyChars: 0, tools: [] } });
    offset = end;
  }
  return { size: listed.size, mtimeMs: listed.mtimeMs, offset };
}
