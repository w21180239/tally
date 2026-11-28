import type { Evidence, HintRule } from "../hint.ts";
import { resolvePrice } from "../pricing.ts";
import { LISTED, shortModel, tokensText, usdText } from "./shared.ts";

/** Floor on what the long-context tier added, in dollars, summed over the models that have one. */
export const LONG_PROMPT_MIN_USD = 1;

export const longPromptTier: HintRule = {
  id: "long-prompt-tier",
  run: ({ summary, prices }) => {
    const found = Object.entries(summary.longPrompts ?? {})
      .filter(([, m]) => m.requests > 0 && m.extraUsd > 0)
      .sort((a, b) => b[1].extraUsd - a[1].extraUsd || (a[0] < b[0] ? -1 : 1));
    const usd = found.reduce((n, [, m]) => n + m.extraUsd, 0);
    if (found.length === 0 || usd < LONG_PROMPT_MIN_USD) return [];
    const threshold = (model: string): string => tokensText(resolvePrice(model, prices)?.price.longContext?.threshold ?? 0);
    const evidence: Evidence[] = found.slice(0, LISTED).map(([model, m]) => ({
      label: "Model",
      detail: `${shortModel(model)}: ${m.requests} ${m.requests === 1 ? "request" : "requests"} over ${threshold(model)} tokens (${m.subRequests} from sub-agents) in ${m.sessions} ${m.sessions === 1 ? "session" : "sessions"}, ${usdText(m.extraUsd)} above the base rates`,
      kind: "text",
    }));
    return [
      {
        rule: "long-prompt-tier",
        title: "Prompts past a model's long-context price step",
        usd,
        summary: `${found.length === 1 ? "A model" : `${found.length} models`} bill every prompt over ${threshold(found[0]![0])} tokens at a multiple of the base rates, which added ${usdText(usd)} here. Models without that step carry the same prompt at the base rate.`,
        action: "Keep these prompts under the step · run /compact before the context passes it, or give the work to a model with no step, such as sonnet (set model: in a sub-agent's definition).",
        evidence,
        short: `${usdText(usd)} from prompts past the price step`,
      },
    ];
  },
};
