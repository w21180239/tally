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
});
