import { describe, test, expect } from "claude-code/testing";
import { parseOversized, takeLines, utf8Length } from "../core/lines.ts";

describe("lines", () => {
  test("utf8Length counts bytes per code point", () => {
    expect(utf8Length("a")).toBe(1);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("中")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
  });
  test("takeLines drops the trailing partial line", () => {
    expect(takeLines("a\nb\nc")).toEqual({ lines: ["a", "b"], consumed: 4, partial: false });
  });
  test("consumed is a byte count", () => {
    const r = takeLines("x\n中文\n半");
    expect(r.consumed).toBe(utf8Length("x\n中文\n"));
    expect(r.consumed).toBe(9);
    expect(r.lines).toEqual(["x", "中文"]);
  });
  test("a cut character at the end stays unconsumed", () => {
    const r = takeLines("a\nb\n�");
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.consumed).toBe(4);
  });
  test("no newline means partial", () => {
    expect(takeLines("abc")).toEqual({ lines: [], consumed: 0, partial: true });
  });
  test("parseOversized reads head and tail fields", () => {
    const head =
      '{"type":"assistant","timestamp":"2026-01-02T03:04:05.000Z","sessionId":"s1","cwd":"/w/p","isSidechain":true,"message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"';
    const tail =
      '"}],"usage":{"input_tokens":3,"cache_creation_input_tokens":30,"cache_read_input_tokens":7,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":20},"output_tokens":120,"speed":"fast"}},"requestId":"req_x"}';
    const r = parseOversized(head, tail);
    expect(r).toEqual({
      requestId: "req_x",
      sessionId: "s1",
      ts: Date.parse("2026-01-02T03:04:05.000Z"),
      model: "claude-opus-5-5",
      tokens: { input: 3, output: 120, cacheRead: 7, cw5m: 10, cw1h: 20 },
      fast: true,
      sidechain: true,
      cwd: "/w/p",
    });
  });
  test("parseOversized falls back to cache_creation_input_tokens and returns null without usage", () => {
    const head = '{"timestamp":"2026-01-02T03:04:05.000Z","sessionId":"s1","isSidechain":false,"message":{"model":"m"';
    const tail = '"usage":{"input_tokens":1,"cache_creation_input_tokens":9,"output_tokens":2}},"requestId":"r"}';
    const r = parseOversized(head, tail);
    expect(r?.tokens).toEqual({ input: 1, output: 2, cacheRead: 0, cw5m: 9, cw1h: 0 });
    expect(r?.fast).toBe(false);
    expect(r?.cwd).toBeUndefined();
    expect(parseOversized(head, "nothing here")).toBeNull();
  });
});
