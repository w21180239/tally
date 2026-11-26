import { describe, test, expect } from "claude-code/testing";
import { CHUNK, readIncrement } from "../engine/reader.ts";
import type { FileState, ReaderEnv } from "../engine/reader.ts";
import { createSlicer } from "../engine/slicer.ts";
import type { FileCtx, Parsed } from "../core/types.ts";
import { assistant } from "./fixtures/lines.ts";
import { worldOf } from "./world.ts";

const P = "/proj/a/sess-1.jsonl";
const ctx: FileCtx = { path: P, isSub: false, repo: "demo" };
const slicer = () => createSlicer(() => 0, async () => {});
const line = (i: number, pad = 0) => assistant({ requestId: `req-${i}`, content: pad ? [{ type: "text", text: "x".repeat(pad) }] : [] });

async function run($: ReaderEnv, prev: FileState | undefined, w: { size(p: string): number | undefined; mtime(p: string): number | undefined }, out: Parsed[]) {
  return readIncrement($, P, prev, { size: w.size(P)!, mtimeMs: w.mtime(P)! }, ctx, (p) => out.push(p), slicer());
}
const ids = (out: Parsed[]) => out.map((p) => (p.t === "usage" ? p.row.requestId : "?"));

describe("readIncrement", () => {
  test("a 10 MB file reads in 3 chunks with the same lines as one pass", async () => {
    const w = worldOf();
    const $ = w.$;
    const text = Array.from({ length: 10_500 }, (_, i) => line(i, 700)).join("\n") + "\n";
    expect(text.length).toBeGreaterThan(10 * 1024 * 1024);
    w.put(P, text);
    const out: Parsed[] = [];
    const st = await run($, undefined, w, out);
    expect(out.length).toBe(10_500);
    expect(ids(out)[10_499]).toBe("req-10499");
    expect(w.reads.length).toBe(3);
    expect(w.reads.every((r) => (r.length ?? 0) <= CHUNK)).toBe(true);
    expect(st.offset).toBe(w.size(P)!);
  });

  test("an unchanged file costs no reads", async () => {
    const w = worldOf();
    const $ = w.$;
    w.put(P, line(1) + "\n");
    const out: Parsed[] = [];
    const st = await run($, undefined, w, out);
    const before = w.reads.length;
    const again = await run($, st, w, out);
    expect(w.reads.length).toBe(before);
    expect(again).toEqual(st);
    expect(out.length).toBe(1);
  });

  test("an append reads only the new bytes", async () => {
    const w = worldOf();
    const $ = w.$;
    w.put(P, line(1) + "\n");
    const out: Parsed[] = [];
    const st = await run($, undefined, w, out);
    w.append(P, line(2) + "\n" + line(3) + "\n");
    await run($, st, w, out);
    expect(ids(out)).toEqual(["req-1", "req-2", "req-3"]);
    expect(w.reads[w.reads.length - 1]!.offset).toBe(st.offset);
  });

  test("a half line at the end waits for its newline", async () => {
    const w = worldOf();
    const $ = w.$;
    const first = line(1) + "\n";
    const half = line(2);
    w.put(P, first + half);
    const out: Parsed[] = [];
    const st = await run($, undefined, w, out);
    expect(out.length).toBe(1);
    expect(st.offset).toBe(first.length);
    expect(st.size).toBe(first.length + half.length);
    w.append(P, "\n");
    await run($, st, w, out);
    expect(ids(out)).toEqual(["req-1", "req-2"]);
  });

  test("a shorter file reads again from 0", async () => {
    const w = worldOf();
    const $ = w.$;
    w.put(P, line(1) + "\n" + line(2) + "\n");
    const out: Parsed[] = [];
    const st = await run($, undefined, w, out);
    w.put(P, line(9) + "\n");
    const again: Parsed[] = [];
    const st2 = await run($, st, w, again);
    expect(ids(again)).toEqual(["req-9"]);
    expect(st2.offset).toBe(w.size(P)!);
  });

  test("multibyte text keeps byte offsets right across chunks", async () => {
    const w = worldOf();
    const $ = w.$;
    const one = (i: number) => assistant({ requestId: `req-${i}`, content: [{ type: "text", text: "é中😀".repeat(100) }] });
    const text = Array.from({ length: 5000 }, (_, i) => one(i)).join("\n") + "\n";
    w.put(P, text);
    expect(w.size(P)!).toBeGreaterThan(CHUNK);
    const out: Parsed[] = [];
    const st = await run($, undefined, w, out);
    expect(out.length).toBe(5000);
    expect(st.offset).toBe(w.size(P)!);
  });

  test("a 5 MiB assistant line yields usage with its requestId", async () => {
    const w = worldOf();
    const $ = w.$;
    const big = line(7, 5 * 1024 * 1024);
    w.put(P, line(1) + "\n" + big + "\n" + line(2) + "\n");
    const out: Parsed[] = [];
    const st = await run($, undefined, w, out);
    expect(ids(out)).toEqual(["req-1", "req-7", "req-2"]);
    const row = (out[1] as Extract<Parsed, { t: "usage" }>).row;
    expect(row.tokens.output).toBe(20);
    expect(row.synthetic).toBe(false);
    expect(w.reads.some((r) => r.length === CHUNK)).toBe(true);
    expect(st.offset).toBe(w.size(P)!);
  });

  test("an oversized line with no newline yet is left alone, then read once terminated", async () => {
    const w = worldOf();
    const $ = w.$;
    const first = line(1) + "\n";
    const big = line(7, 5 * 1024 * 1024);
    w.put(P, first + big);
    const out: Parsed[] = [];
    const st = await run($, undefined, w, out);
    expect(ids(out)).toEqual(["req-1"]);
    expect(st.offset).toBe(first.length);
    w.append(P, "\n");
    await run($, st, w, out);
    expect(ids(out)).toEqual(["req-1", "req-7"]);
  });

  // Oversized-line and byte-accuracy cases.
  const enc = new TextEncoder();
  const cat = (...parts: (string | number[])[]): Uint8Array => {
    const bufs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : Uint8Array.from(p)));
    const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of bufs) {
      out.set(b, at);
      at += b.length;
    }
    return out;
  };
  // Usage comes after the padding, so it sits in the last 64 KiB of the line.
  const tailUsage = (id: string, pad: string): string =>
    JSON.stringify({
      type: "assistant",
      sessionId: "sess-1",
      timestamp: "2026-01-02T03:04:05.000Z",
      requestId: id,
      message: { model: "claude-test-1", content: [{ type: "text", text: pad }], usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
    });
  const NINE = "é中😀"; // 2 + 3 + 4 = 9 bytes

  test("a ~9 MiB multibyte line spanning 3 chunks parses from its tail and the next line follows", async () => {
    const w = worldOf();
    const big = tailUsage("req-big", NINE.repeat(1_000_000));
    w.put(P, line(1) + "\n" + big + "\n" + line(2) + "\n");
    expect(w.size(P)!).toBeGreaterThan(2 * CHUNK + 1);
    const out: Parsed[] = [];
    const st = await run(w.$, undefined, w, out);
    expect(ids(out)).toEqual(["req-1", "req-big", "req-2"]);
    const row = (out[1] as Extract<Parsed, { t: "usage" }>).row;
    expect(row.tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cw5m: 4, cw1h: 0 });
    expect(st.offset).toBe(w.size(P)!);
  });

  test("an oversized line that is not an assistant row is skipped and the next line still parses", async () => {
    const w = worldOf();
    const bigUser = JSON.stringify({ type: "user", sessionId: "sess-1", timestamp: "2026-01-02T03:04:05.000Z", message: { role: "user", content: "x".repeat(5 * 1024 * 1024) } });
    w.put(P, line(1) + "\n" + bigUser + "\n" + line(2) + "\n");
    const out: Parsed[] = [];
    const st = await run(w.$, undefined, w, out);
    expect(ids(out)).toEqual(["req-1", "req-2"]);
    expect(st.offset).toBe(w.size(P)!);
  });

  test("a newline at the end of chunk 1 and one at the start of chunk 2 both land correctly", async () => {
    for (const lineLen of [CHUNK - 1, CHUNK]) {
      const w = worldOf();
      const base = line(5).length;
      const l = line(5, lineLen - base - 0);
      // Fit the line to lineLen bytes exactly (the empty-content line carries "content":[] already).
      const fitted = line(5, lineLen - (line(5, 1).length - 1));
      expect(fitted.length).toBe(lineLen);
      void l;
      w.put(P, fitted + "\n" + line(6) + "\n");
      const out: Parsed[] = [];
      const st = await run(w.$, undefined, w, out);
      expect(ids(out)).toEqual(["req-5", "req-6"]);
      expect(st.offset).toBe(w.size(P)!);
    }
  });

  test("an invalid byte inside a line does not shift the next line", async () => {
    const w = worldOf();
    const a = line(1, 10).replace("xxxxxxxxxx", "xxxxx@xxxx");
    const [pre, post] = a.split("@");
    w.putBytes(P, cat(pre!, [0xff, 0xfe], post! + "\n" + line(2) + "\n" + line(3) + "\n"));
    const out: Parsed[] = [];
    const st = await run(w.$, undefined, w, out);
    expect(ids(out)).toEqual(["req-1", "req-2", "req-3"]);
    expect(st.offset).toBe(w.size(P)!);
  });

  test("invalid bytes and literal U+FFFD in an early chunk keep every later chunk line-aligned", async () => {
    const w = worldOf();
    const parts: (string | number[])[] = [];
    const n = 10_500;
    for (let i = 0; i < n; i++) {
      const pad = i % 400 === 7 ? "ab@cd�@ef" : "x".repeat(700);
      const pieces = line(i, 0).replace('"content":[]', `"content":[{"type":"text","text":"${pad}"}]`).split("@");
      if (pieces.length === 1) parts.push(pieces[0]! + "\n");
      else parts.push(pieces[0]!, [0xc3], pieces[1]!, [0xff], pieces[2]! + "\n"); // truncated 2-byte lead, then a lone 0xFF
    }
    w.putBytes(P, cat(...parts));
    expect(w.size(P)!).toBeGreaterThan(2 * CHUNK);
    const out: Parsed[] = [];
    const st = await run(w.$, undefined, w, out);
    expect(out.length).toBe(n);
    expect(ids(out)[n - 1]).toBe(`req-${n - 1}`);
    expect(st.offset).toBe(w.size(P)!);
  });

  test("invalid bytes in the last chunk of an oversized line keep the next line aligned", async () => {
    const w = worldOf();
    const big = tailUsage("req-big", "x".repeat(5 * 1024 * 1024) + "@@@@");
    const [pre, post] = big.split("@@@@");
    w.putBytes(P, cat(pre!, [0xff, 0xc3, 0xff, 0xe4, 0xb8], post! + "\n" + line(2) + "\n"));
    const out: Parsed[] = [];
    const st = await run(w.$, undefined, w, out);
    expect(ids(out)).toEqual(["req-big", "req-2"]);
    expect(st.offset).toBe(w.size(P)!);
  });

  test("a tiny budget makes the reader yield between lines", async () => {
    const w = worldOf();
    w.put(P, line(1) + "\n" + line(2) + "\n" + line(3) + "\n");
    let t = 0;
    let yields = 0;
    const s = createSlicer(() => t++, async () => void yields++, 0);
    const out: Parsed[] = [];
    await readIncrement(w.$, P, undefined, { size: w.size(P)!, mtimeMs: w.mtime(P)! }, ctx, (p) => out.push(p), s);
    expect(out.length).toBe(3);
    expect(yields).toBeGreaterThanOrEqual(3);
  });
});
