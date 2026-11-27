import type { Evidence, HintRule } from "../hint.ts";
import { resolvePrice } from "../pricing.ts";
import { LISTED, percentText, pricedTokens, shortModel, usdText } from "./shared.ts";

/** Fraction of flagship tool turns the read-only ones must exceed, and the floor on what Sonnet rates would save on them, in dollars. */
export const READ_ONLY_SHARE = 0.6;
export const SAVING_MIN_USD = 1;

const FLAGSHIP = /(opus|fable)/i;

export const mainModelOverkill: HintRule = {
  id: "main-model-overkill",
  run: ({ summary, prices }) => {
    const sonnet = resolvePrice("claude-sonnet", prices)?.price;
    if (sonnet === undefined) return [];
    let turns = 0;
    let reading = 0;
    const found: Array<{ model: string; turns: number; reading: number; usd: number; saving: number }> = [];
    for (const [model, m] of Object.entries(summary.mainTools)) {
      if (!FLAGSHIP.test(model)) continue;
      turns += m.turns;
      reading += m.readOnly.requests;
      const saving = m.readOnly.usd - pricedTokens(m.readOnly.tokens, sonnet);
      if (m.readOnly.requests > 0 && saving > 0) found.push({ model, turns: m.turns, reading: m.readOnly.requests, usd: m.readOnly.usd, saving });
    }
    const usd = found.reduce((n, f) => n + f.saving, 0);
    if (turns === 0 || reading / turns <= READ_ONLY_SHARE || usd < SAVING_MIN_USD) return [];
    found.sort((a, b) => b.saving - a.saving || (a.model < b.model ? -1 : 1));
    const evidence: Evidence[] = found.slice(0, LISTED).map((f) => ({
      label: "Model",
      detail: `${shortModel(f.model)}: ${f.reading} of ${f.turns} tool turns read-only; ${usdText(f.usd)} spent, ${usdText(f.usd - f.saving)} on sonnet`,
      kind: "text",
    }));
    return [
      {
        rule: "main-model-overkill",
        title: "Read-only work on a flagship model",
        usd,
        projected: true,
        summary: `${percentText(reading / turns)} of the tool-calling turns on opus and fable models (${reading} of ${turns}) only read or searched. Priced at Sonnet rates, those requests come to ${usdText(usd)} less.`,
        action: "Run exploration and reading on Sonnet (switch with /model) or hand that work to a Sonnet sub-agent, and move up to the flagship model for the edits that need it.",
        evidence,
        short: `${percentText(reading / turns)} of flagship tool turns were read-only`,
      },
    ];
  },
};
