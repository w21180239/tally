import type { Evidence, HintInput, HintRule } from "../hint.ts";
import { resolvePrice } from "../pricing.ts";
import { FLAGSHIP, LISTED, percentText, pricedTokens, shortModel, usdText } from "./shared.ts";

/** Fraction of flagship tool turns the read-only ones must exceed, and the floor on what Sonnet rates would save on them, in dollars. */
export const READ_ONLY_SHARE = 0.6;
export const SAVING_MIN_USD = 1;
/** Floor on the flagship tool turns: most edit sessions read before they write, so a short span says little. */
export const MIN_TURNS = 50;

// Read-only share of the flagship models' tool turns. Base: the dollars Sonnet rates save per unit of share.
const readOnlyShare = ({ summary }: HintInput): number => {
  let turns = 0;
  let reading = 0;
  for (const [model, m] of Object.entries(summary.mainTools)) {
    if (!FLAGSHIP.test(model)) continue;
    turns += m.turns;
    reading += m.readOnly.requests;
  }
  return turns > 0 ? reading / turns : 0;
};

export const mainModelOverkill: HintRule = {
  id: "main-model-overkill",
  metric: readOnlyShare,
  run: (i) => {
    const { summary, prices } = i;
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
    if (turns < MIN_TURNS || reading / turns <= READ_ONLY_SHARE || usd < SAVING_MIN_USD) return [];
    found.sort((a, b) => b.saving - a.saving || (a.model < b.model ? -1 : 1));
    // The top tier above the default one: when it carries most of the saving, the first step down is the default flagship.
    const topTier = found.filter((f) => /(fable|mythos)/i.test(f.model)).reduce((n, f) => n + f.saving, 0) > usd / 2;
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
        confidence: "low",
        summary: `${percentText(reading / turns)} of the tool-calling turns on opus, fable and mythos models (${reading} of ${turns}) only read or searched. Priced at Sonnet rates with the same token counts, those requests come to ${usdText(usd)} less; reading is part of every edit session, so the figure is an estimate until tried.`,
        action: `${topTier ? "Try the default flagship model first for this work. " : ""}Choose the model at the start of a session · run /model sonnet for read-heavy work, or set opusplan so only plan mode uses the flagship. Add an Explore agent with a model: line to route searches to a cheaper model. Switching mid-session re-reads the whole context uncached.`,
        evidence,
        short: `${percentText(reading / turns)} of flagship tool turns were read-only`,
        metric: { name: "read-only share of flagship turns", value: readOnlyShare(i) },
      },
    ];
  },
};
