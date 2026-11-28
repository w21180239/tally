import type { Evidence, HintRule } from "../hint.ts";
import { resolvePrice } from "../pricing.ts";
import type { Summary } from "../summary.ts";
import { FLAGSHIP, LISTED, pricedTokens as priced, shortModel, usdText } from "./shared.ts";

const LOOKING: ReadonlySet<string> = new Set(["read", "grep", "glob", "ls", "webfetch", "websearch", "bash"]);
// Tools that cannot change anything; a shell can, so a type that runs one fires but is not high confidence.
const READ_ONLY: ReadonlySet<string> = new Set(["read", "grep", "glob", "ls", "webfetch", "websearch"]);
const HANDBACK: ReadonlySet<string> = new Set(["subagenthandback", "structuredoutput"]);

// A type is high confidence when all of these hold, so a cheaper model can be expected to cope with its work.
const MAX_AVG_OUTPUT = 2000;
const MAX_ERROR_SHARE = 0.05;
const MAX_AVG_TURNS = 10;

const LOW_ACTION = "Try sonnet for one week";
const HIGH_ACTION =
  "Add a `model:` line (sonnet, or haiku for small contexts) to those agent definitions. The built-in Explore agent follows the main model: add an Explore agent file with a `model:` line. CLAUDE_CODE_SUBAGENT_MODEL covers agents with no model of their own; add CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 to override definitions too.";

type Slice = Summary["bySubType"][string];

// Figures over all of a type's models. A turn is one request; a task is one sub-agent conversation, and
// without a task count (shards from before agent ids) turns per task cannot be shown.
function steady(s: Summary, type: string, byModel: Slice): boolean {
  let requests = 0;
  let output = 0;
  for (const m of Object.values(byModel)) {
    requests += m.requests;
    output += m.tokens.output;
    for (const name of Object.keys(m.tools)) {
      const n = name.toLowerCase();
      if (!HANDBACK.has(n) && !READ_ONLY.has(n)) return false;
    }
  }
  const st = s.subStats?.[type];
  if (st === undefined || st.tasks <= 0) return false;
  return output < MAX_AVG_OUTPUT * requests && (st.results === 0 || st.errors / st.results < MAX_ERROR_SHARE) && requests <= MAX_AVG_TURNS * st.tasks;
}

export const subagentModel: HintRule = {
  id: "subagent-model",
  run: ({ summary, prices }) => {
    const sonnet = resolvePrice("claude-sonnet", prices)?.price;
    const haiku = resolvePrice("claude-haiku", prices)?.price;
    if (sonnet === undefined) return [];
    const found: Array<{ type: string; model: string; usd: number; onSonnet: number; onHaiku: number | null }> = [];
    const types = new Set<string>();
    for (const [type, byModel] of Object.entries(summary.bySubType)) {
      if (type === "unknown") continue;
      for (const [model, m] of Object.entries(byModel)) {
        if (!FLAGSHIP.test(model)) continue;
        const tools = Object.keys(m.tools).map((n) => n.toLowerCase()).filter((n) => !HANDBACK.has(n));
        // A type that called no tools passes this check vacuously, which is intended.
        if (!tools.every((n) => LOOKING.has(n))) continue;
        const onSonnet = m.usd - priced(m.tokens, sonnet);
        if (onSonnet <= 0) continue;
        // Haiku bills prompts over its tier threshold at a multiple, which this flat pricing leaves out: with prompts that big its saving is not shown.
        const prompt = m.requests > 0 ? (m.tokens.input + m.tokens.cacheRead + m.tokens.cw5m + m.tokens.cw1h) / m.requests : 0;
        const haikuFits = haiku !== undefined && (haiku.longContext === undefined || prompt <= haiku.longContext.threshold);
        found.push({ type, model, usd: m.usd, onSonnet, onHaiku: haikuFits ? m.usd - priced(m.tokens, haiku) : null });
        types.add(type);
      }
    }
    if (found.length === 0) return [];
    found.sort((a, b) => b.onSonnet - a.onSonnet || (a.type < b.type ? -1 : 1));
    const usd = found.reduce((n, f) => n + f.onSonnet, 0);
    const high = [...types].every((t) => steady(summary, t, summary.bySubType[t]!));
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
        confidence: high ? "high" : "low",
        summary: `${found.length} sub-agent ${found.length === 1 ? "type" : "types"} used only read and search tools (or none) but ran on a top-tier model. The same token usage at Sonnet prices would be ${usdText(usd)} cheaper.${high ? "" : " Shell calls, long replies, failed tool calls or many turns per task show up in some of them, so the saving is an estimate until tried."}`,
        action: high ? HIGH_ACTION : LOW_ACTION,
        evidence,
        short: `${found.length} lookup-only ${found.length === 1 ? "agent" : "agents"} on a flagship model`,
      },
    ];
  },
};
