import type { Evidence, HintRule } from "../hint.ts";
import { resolvePrice } from "../pricing.ts";
import type { ModelPrice } from "../pricing.ts";
import type { Tokens } from "../types.ts";
import { LISTED, usdText } from "./shared.ts";

// Read-only tool names, lower-cased. An agent type that calls only these seldom needs a flagship model.
const LOOKING: ReadonlySet<string> = new Set(["read", "grep", "glob", "ls", "webfetch", "websearch", "bash"]);
// Result-return tools every type uses; they reveal nothing about what the agent did.
const HANDBACK: ReadonlySet<string> = new Set(["subagenthandback", "structuredoutput"]);
const BIG = /(opus|fable)/i;

const priced = (t: Tokens, p: ModelPrice): number => (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cw5m * p.cw5m + t.cw1h * p.cw1h) / 1e6;
const shortModel = (model: string): string => model.replace(/^claude-/, "");

export const subagentModel: HintRule = {
  id: "subagent-model",
  run: ({ summary, prices }) => {
    const sonnet = resolvePrice("claude-sonnet", prices)?.price;
    const haiku = resolvePrice("claude-haiku", prices)?.price;
    if (sonnet === undefined) return [];
    const found: Array<{ type: string; model: string; usd: number; onSonnet: number; onHaiku: number | null }> = [];
    for (const [type, byModel] of Object.entries(summary.bySubType)) {
      if (type === "unknown") continue;
      for (const [model, m] of Object.entries(byModel)) {
        if (!BIG.test(model)) continue;
        const tools = Object.keys(m.tools).map((n) => n.toLowerCase()).filter((n) => !HANDBACK.has(n));
        if (tools.length === 0 || !tools.every((n) => LOOKING.has(n))) continue;
        const onSonnet = m.usd - priced(m.tokens, sonnet);
        if (onSonnet <= 0) continue;
        found.push({ type, model, usd: m.usd, onSonnet, onHaiku: haiku === undefined ? null : m.usd - priced(m.tokens, haiku) });
      }
    }
    if (found.length === 0) return [];
    found.sort((a, b) => b.onSonnet - a.onSonnet || (a.type < b.type ? -1 : 1));
    const usd = found.reduce((n, f) => n + f.onSonnet, 0);
    const evidence: Evidence[] = found.slice(0, LISTED).map((f) => ({
      label: f.type,
      detail: `${usdText(f.usd)} on ${shortModel(f.model)}; priced on sonnet ${usdText(f.usd - f.onSonnet)}${f.onHaiku === null ? "" : `, on haiku ${usdText(f.usd - f.onHaiku)}`}`,
      kind: "text",
    }));
    return [
      {
        rule: "subagent-model",
        title: "Read-only sub-agents on a flagship model",
        usd,
        projected: true,
        summary: `${found.length} sub-agent ${found.length === 1 ? "type" : "types"} ran only read-only tools on a top-tier model; at Sonnet rates the identical tokens come to ${usdText(usd)} less.`,
        action: "Set `model: sonnet` (or haiku) in those agent definitions, or export CLAUDE_CODE_SUBAGENT_MODEL to change the default.",
        evidence,
        short: `${found.length} read-only ${found.length === 1 ? "agent" : "agents"} on a big model`,
      },
    ];
  },
};
