// Synthetic month: 3 repos, 2 models, sub-agents, one fast session. Expected values are hand-computed
// in tests/summary.test.ts from the layout below.
//
// Prices (USD/MTok): opus in 10 out 50 cacheRead 1 cw5m 12.5 cw1h 20; sonnet in 2 out 10 cacheRead 0.2 cw5m 2.5 cw1h 4; fast x2.
// One unit of request is k x { input 100k, output 20k (opus) or 50k (sonnet), cacheRead 1M, cw5m 40k }:
// opus = $3.50 per k, sonnet = $1.00 per k.
import type { PriceTable } from "../../core/pricing.ts";
import type { Shard, ShardFile } from "../../core/shard.ts";
import type { MetaRow, ToolUse, UsageRow } from "../../core/types.ts";

export const PRICES: PriceTable = {
  source: "builtin",
  updatedAt: 0,
  fastMul: 2,
  models: {
    "claude-opus-5-5": { input: 10, output: 50, cacheRead: 1, cw5m: 12.5, cw1h: 20 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cw5m: 2.5, cw1h: 4 },
  },
};

export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";
/** 2026-11-27T12:30:00Z */
export const NOW = Date.UTC(2026, 10, 27, 12, 30);
/** NZDT: local now is 2026-11-28 01:30. */
export const TZ = 780;

const at = (iso: string) => Date.parse(iso);

export type Spec = {
  id: string;
  session: string;
  ts: string;
  model: string;
  k: number;
  cwd: string;
  sidechain?: boolean;
  fast?: boolean;
  synthetic?: boolean;
  skill?: string;
  plugin?: string;
  tools?: ToolUse[];
  agentType?: string;
};

export function usage(s: Spec): UsageRow {
  const row: UsageRow = {
    requestId: s.id,
    sessionId: s.session,
    ts: at(s.ts),
    model: s.model,
    tokens: { input: 100_000 * s.k, output: (s.model === SONNET ? 50_000 : 20_000) * s.k, cacheRead: 1_000_000 * s.k, cw5m: 40_000 * s.k, cw1h: 0 },
    fast: s.fast === true,
    sidechain: s.sidechain === true,
    synthetic: s.synthetic === true,
    thinkingChars: 0,
    replyChars: 0,
    tools: s.tools ?? [],
    cwd: s.cwd,
  };
  if (s.skill) row.skill = s.skill;
  if (s.plugin) row.plugin = s.plugin;
  if (s.agentType) row.agentType = s.agentType;
  return row;
}

const file = (sessionId: string, agentType: string): ShardFile => ({ size: 1, mtimeMs: 1, offset: 1, isSub: true, agentType, sessionId });
const meta = (sessionId: string, key: MetaRow["key"], value: string): MetaRow => ({ sessionId, key, value });
const mcp = (n: number): ToolUse[] => Array.from({ length: n }, () => ({ name: "mcp__docs__lookup", mcpServer: "docs", inputChars: 1 }));
const tool = (name: string): ToolUse => ({ name, inputChars: 1 });

const A = "/work/alpha";
const B = "/work/beta";
const G = "/work/gamma";

export const specs1: Spec[] = [
  // s1 alpha: custom + ai title, Explore sub-agent
  { id: "r1", session: "s1", ts: "2026-10-30T02:00:00Z", model: OPUS, k: 2, cwd: A },
  { id: "r2", session: "s1", ts: "2026-11-05T22:30:00Z", model: SONNET, k: 4, cwd: A },
  { id: "r3", session: "s1", ts: "2026-11-05T22:40:00Z", model: SONNET, k: 2, cwd: A, sidechain: true, tools: [tool("Read")], agentType: "Explore" },
  { id: "r4", session: "s1", ts: "2026-11-05T22:45:00Z", model: OPUS, k: 1, cwd: A, sidechain: true, tools: [tool("Bash")], agentType: "Explore" },
  // s2 beta: skill + plugin, general-purpose sub-agent, an unpriced model
  { id: "r5", session: "s2", ts: "2026-11-20T08:00:00Z", model: OPUS, k: 3, cwd: B, skill: "brainstorm", plugin: "superpowers" },
  { id: "r6", session: "s2", ts: "2026-11-20T08:10:00Z", model: OPUS, k: 1, cwd: B, sidechain: true, tools: [tool("Read"), tool("Read"), ...mcp(1)], agentType: "general-purpose" },
  { id: "r7", session: "s2", ts: "2026-11-20T08:20:00Z", model: SONNET, k: 1, cwd: B, sidechain: true, tools: [tool("Grep")], agentType: "general-purpose" },
  { id: "r13", session: "s2", ts: "2026-11-10T00:00:00Z", model: "claude-unknown-1", k: 1, cwd: B },
  // s5 gamma: sidechain row without an agentType (older index): reads as unknown
  { id: "r15", session: "s5", ts: "2026-11-12T03:00:00Z", model: SONNET, k: 1, cwd: G, sidechain: true },
  // outside the 30-day window
  { id: "r12", session: "s7", ts: "2026-10-20T00:00:00Z", model: OPUS, k: 10, cwd: A },
  { id: "r16", session: "s8", ts: "2026-10-29T10:59:59.999Z", model: SONNET, k: 1, cwd: A },
  // synthetic rows are not requests
  { id: "r14", session: "s2", ts: "2026-11-10T01:00:00Z", model: "<synthetic>", k: 1, cwd: B, synthetic: true },
];

export const specs2: Spec[] = [
  // s3 gamma: a fast session
  { id: "r8", session: "s3", ts: "2026-11-26T20:00:00Z", model: OPUS, k: 2, cwd: G, fast: true },
  { id: "r9", session: "s3", ts: "2026-11-26T20:30:00Z", model: SONNET, k: 2, cwd: G, tools: mcp(2) },
  // s4 alpha via a worktree, in the last 24 hours; the newest session
  { id: "r10", session: "s4", ts: "2026-11-27T10:15:00Z", model: SONNET, k: 5, cwd: `${A}/.claude/worktrees/w1` },
  { id: "r11", session: "s4", ts: "2026-11-27T12:10:00Z", model: OPUS, k: 1, cwd: A },
  // s6 alpha: exactly on the first instant of the 30-day window
  { id: "r17", session: "s6", ts: "2026-10-29T11:00:00Z", model: SONNET, k: 1, cwd: A },
];

const empty = (project: string): Shard => ({ v: 1, project, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] });

export function month(): Shard[] {
  const p1 = empty("p1");
  p1.usage = specs1.map(usage);
  p1.files = {
    "/p/s1/subagents/agent-a1.jsonl": file("s1", "Explore"),
    "/p/s2/subagents/agent-a2.jsonl": file("s2", "general-purpose"),
    "/p/s5/subagents/agent-a3.jsonl": file("s5", "Plan"),
    "/p/s5/subagents/agent-a4.jsonl": file("s5", "Explore"),
    "/p/s1.jsonl": { size: 1, mtimeMs: 1, offset: 1, isSub: false, sessionId: "s1" },
  };
  p1.metas = [
    meta("s1", "ai-title", "Alpha auto"),
    meta("s1", "custom-title", "Alpha custom"),
    meta("s2", "custom-title", "Beta work"),
    meta("s2", "pr-link", "https://example.test/pr/7"),
  ];
  const p2 = empty("p2");
  p2.usage = specs2.map(usage);
  p2.metas = [meta("s3", "ai-title", "Gamma fast")];
  return [p1, p2];
}
