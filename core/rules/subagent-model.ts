import type { Evidence, HintRule } from "../hint.ts";
import { resolvePrice } from "../pricing.ts";
import type { ModelPrice } from "../pricing.ts";
import type { Tokens } from "../types.ts";
import { LISTED, usdText } from "./shared.ts";

// Inspection-only tools: a type restricted to them is a cheaper-model candidate.
const LOOKING: ReadonlySet<string> = new Set(["read", "grep", "glob", "ls", "webfetch", "websearch", "bash"]);
// Tools that carry results back to the parent; ignored when judging what a type does.
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
        // A type that called no tools passes this check vacuously, which is intended.
        if (!tools.every((n) => LOOKING.has(n))) continue;
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
        title: "Flagship models on lookup-only sub-agents",
        usd,
        projected: true,
        summary: `${found.length} sub-agent ${found.length === 1 ? "type" : "types"} used only read and search tools (or none) but ran on a top-tier model. The same token usage at Sonnet prices would be ${usdText(usd)} cheaper.`,
        action: "Add a `model:` line (sonnet or haiku) to those agent definitions, or set CLAUDE_CODE_SUBAGENT_MODEL to move every sub-agent at once.",
        evidence,
        short: `${found.length} lookup-only ${found.length === 1 ? "agent" : "agents"} on a flagship model`,
      },
    ];
  },
};
