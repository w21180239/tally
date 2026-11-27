import { describe, test, expect } from "claude-code/testing";
import { parseLine } from "../core/parse.ts";
import type { FileCtx, Parsed } from "../core/types.ts";
import { assistant, user, toolResult, compactBoundary, meta, SESSION, TIME } from "./fixtures/lines.ts";

const ctx: FileCtx = { path: "/p/sess-1.jsonl", isSub: false, repo: "demo" };
const sub: FileCtx = { path: "/p/sess-1/subagents/agent-a.jsonl", isSub: true, agentType: "x", repo: "demo" };
const usage = (p: Parsed | null) => {
  if (!p || p.t !== "usage") throw new Error("not usage");
  return p.row;
};
const userRow = (p: Parsed | null) => {
  if (!p || p.t !== "user") throw new Error("not user");
  return p.row;
};

describe("parseLine usage", () => {
  test("maps the cache_creation split", () => {
    const r = usage(
      parseLine(
        assistant({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 9, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 } } }),
        ctx,
      ),
    );
    expect(r.tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cw5m: 4, cw1h: 5 });
    expect(r.requestId).toBe("req-1");
    expect(r.sessionId).toBe(SESSION);
    expect(r.ts).toBe(TIME);
    expect(r.cwd).toBe("/work/demo");
  });
  test("without the split, all writes are 5m", () => {
    const r = usage(parseLine(assistant(), ctx));
    expect(r.tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cw5m: 40, cw1h: 0 });
  });
  test("fast and synthetic flags", () => {
    expect(usage(parseLine(assistant({ usage: { speed: "fast" } }), ctx)).fast).toBe(true);
    expect(usage(parseLine(assistant(), ctx)).fast).toBe(false);
    expect(usage(parseLine(assistant({ model: "<synthetic>" }), ctx)).synthetic).toBe(true);
    expect(usage(parseLine(assistant(), ctx)).synthetic).toBe(false);
  });
  test("thinking and reply chars", () => {
    const r = usage(
      parseLine(assistant({ content: [{ type: "thinking", thinking: "abcde" }, { type: "text", text: "hello" }, { type: "text", text: "xy" }] }), ctx),
    );
    expect(r.thinkingChars).toBe(5);
    expect(r.replyChars).toBe(7);
  });
  test("tools: mcp server, Bash command, Read target", () => {
    const r = usage(
      parseLine(
        assistant({
          content: [
            { type: "tool_use", id: "t1", name: "mcp__srv__do", input: { a: 1 } },
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls -l" } },
            { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/x/y.ts" } },
            { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/x/y.ts" } },
          ],
        }),
        ctx,
      ),
    );
    expect(r.tools.length).toBe(3);
    expect(r.tools[0].mcpServer).toBe("srv");
    expect(r.tools[1].command).toBe("ls -l");
    expect(r.tools[2].target).toBe("/x/y.ts");
    expect(r.tools[1].inputChars).toBe(JSON.stringify({ command: "ls -l" }).length);
  });
  test("tool ids and whole reads: a Read without offset, limit or pages is whole", () => {
    const r = usage(
      parseLine(
        assistant({
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
            { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a", offset: 5 } },
            { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/a", limit: 5 } },
            { type: "tool_use", id: "t4", name: "Read", input: { file_path: "/a.pdf", pages: "1-2" } },
            { type: "tool_use", id: "t5", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", name: "Read", input: { file_path: "/b" } },
          ],
        }),
        ctx,
      ),
    );
    expect(r.tools.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4", "t5", undefined]);
    expect(r.tools.map((t) => t.whole === true)).toEqual([true, false, false, false, false, true]);
  });
  test("user rows from a sub-agent transcript or a sidechain line are marked", () => {
    const line = user([{ type: "tool_result", tool_use_id: "a", content: "1" }]);
    expect(userRow(parseLine(line, ctx)).sidechain).toBeUndefined();
    expect(userRow(parseLine(line, sub)).sidechain).toBe(true);
    expect(userRow(parseLine(user("hi", { isSidechain: true }), ctx)).sidechain).toBe(true);
  });
  test("attribution, effort and sidechain", () => {
    const r = usage(parseLine(assistant({ extra: { attributionSkill: "sk", attributionPlugin: "pl", perTurnEffort: "high", isSidechain: true } }), ctx));
    expect([r.skill, r.plugin, r.effort, r.sidechain]).toEqual(["sk", "pl", "high", true]);
    expect(usage(parseLine(assistant(), sub)).sidechain).toBe(true);
  });
  test("line without a requestId is skipped", () => {
    expect(parseLine(JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:00Z", message: {} }), ctx)).toBe(null);
  });
});

describe("parseLine user", () => {
  test("prompt", () => {
    const r = userRow(parseLine(user("hello there"), ctx));
    expect(r).toEqual({ sessionId: SESSION, ts: TIME, kind: "prompt", chars: 11, text: "hello there" });
  });
  test("prompt as text blocks", () => {
    expect(userRow(parseLine(user([{ type: "text", text: "ab" }]), ctx)).kind).toBe("prompt");
  });
  test("compaction summary", () => {
    expect(userRow(parseLine(user("summary", { isCompactSummary: true }), ctx)).kind).toBe("compaction");
  });
  test("notices", () => {
    expect(userRow(parseLine(user("<task-notification>done</task-notification>"), ctx)).kind).toBe("notice");
    expect(userRow(parseLine(user("  <system-reminder>x</system-reminder>"), ctx)).kind).toBe("notice");
    expect(userRow(parseLine(user("note", { isMeta: true }), ctx)).kind).toBe("notice");
  });
  test("tool result chars and id", () => {
    const r = userRow(parseLine(toolResult("tu-1", "12345"), ctx));
    expect(r.kind).toBe("toolResult");
    expect(r.toolUseId).toBe("tu-1");
    expect(r.chars).toBe(5);
    expect(userRow(parseLine(toolResult("tu-2", [{ type: "text", text: "a" }]), ctx)).chars).toBe(JSON.stringify([{ type: "text", text: "a" }]).length);
  });
  test("several tool results keep per-block sizes", () => {
    const line = user([
      { type: "tool_result", tool_use_id: "a", content: "1" },
      { type: "tool_result", tool_use_id: "b", content: "22" },
      { type: "tool_result", tool_use_id: "c", content: "333" },
    ]);
    const r = userRow(parseLine(line, ctx));
    expect(r.results).toEqual([
      { toolUseId: "a", chars: 1 },
      { toolUseId: "b", chars: 2 },
      { toolUseId: "c", chars: 3 },
    ]);
    expect(r.chars).toBe(6);
    expect(r.toolUseId).toBe("a");
  });
  test("empty user line is skipped", () => {
    expect(parseLine(user(""), ctx)).toBe(null);
  });
});

describe("parseLine other", () => {
  test("compact boundary", () => {
    expect(parseLine(compactBoundary(), ctx)).toEqual({ t: "compact", row: { sessionId: SESSION, ts: TIME } });
  });
  test("other system lines are ignored", () => {
    expect(parseLine(JSON.stringify({ type: "system", subtype: "info", timestamp: "2026-01-01T00:00:00Z" }), ctx)).toBe(null);
  });
  test("six meta kinds", () => {
    const cases: [string, Record<string, unknown>, unknown][] = [
      ["custom-title", { customTitle: "T1" }, "T1"],
      ["ai-title", { aiTitle: "T2" }, "T2"],
      ["agent-name", { agentName: "N" }, "N"],
      ["last-prompt", { lastPrompt: "P" }, "P"],
      ["pr-link", { prUrl: "https://example.test/pr/1" }, "https://example.test/pr/1"],
      ["cost-state", { startTime: 5, totalCostUSD: 1.5, modelUsage: { m: { costUSD: 1.5 } } }, { startTime: 5, totalCostUSD: 1.5, modelUsage: { m: { costUSD: 1.5 } } }],
    ];
    for (const [key, fields, value] of cases) {
      expect(parseLine(meta(key, fields), ctx)).toEqual({ t: "meta", row: { sessionId: SESSION, key, value } });
    }
  });
  test("meta lines in subagent files are ignored", () => {
    expect(parseLine(meta("ai-title", { aiTitle: "T" }), sub)).toBe(null);
  });
  test("corrupt or foreign JSON returns null", () => {
    expect(parseLine('{"type":"assistant","mess', ctx)).toBe(null);
    expect(parseLine("[1]", ctx)).toBe(null);
    expect(parseLine('{"type":"progress"}', ctx)).toBe(null);
  });
});

describe("parseLine agentType", () => {
  test("a sub-file row carries the file's agent type; a main-file row has none", () => {
    expect(usage(parseLine(assistant(), sub)).agentType).toBe("x");
    expect("agentType" in usage(parseLine(assistant(), ctx))).toBe(false);
  });
  test("a sub file without a type leaves it absent", () => {
    expect("agentType" in usage(parseLine(assistant(), { ...sub, agentType: undefined }))).toBe(false);
  });
});

describe("parseLine agentId", () => {
  test("rows from a sub-agent transcript carry the transcript's id; main-file rows have none", () => {
    expect(usage(parseLine(assistant(), sub)).agentId).toBe("agent-a");
    expect(userRow(parseLine(user("hi"), sub)).agentId).toBe("agent-a");
    const c = parseLine(compactBoundary(), sub);
    expect(c && c.t === "compact" ? c.row.agentId : "?").toBe("agent-a");
    expect("agentId" in usage(parseLine(assistant(), ctx))).toBe(false);
    expect("agentId" in userRow(parseLine(user("hi"), ctx))).toBe(false);
    expect("agentId" in usage(parseLine(assistant({ extra: { isSidechain: true } }), ctx))).toBe(false);
  });
});
