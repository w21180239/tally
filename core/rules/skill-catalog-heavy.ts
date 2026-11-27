import { nearestSnapshot } from "../breakdown.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { LISTED, proxyNote, residentUsdPerToken, tokensText, usdText } from "./shared.ts";

/**
 * Floor on what the whole skill list costs to carry, in dollars, and on its part of all spend (strictly over); ceiling (exclusive) on the fraction of listed skills called in the span.
 * The share keeps the rule meaningful at any spend level: only a list that is an unusually large part of a span passes 3%.
 */
export const SKILL_CATALOG_MIN_USD = 1;
export const SKILL_CATALOG_MIN_SHARE = 0.03;
export const SKILL_USED_MAX_SHARE = 0.5;

// Plugin skills appear unprefixed in the list, yet a call record may read `plugin:name`.
const bare = (name: string): string => name.slice(name.lastIndexOf(":") + 1);

export const skillCatalogHeavy: HintRule = {
  id: "skill-catalog-heavy",
  run: ({ summary, snaps, prices, live }) => {
    const near = nearestSnapshot(snaps, summary.to, live?.sessionId);
    const perToken = residentUsdPerToken(summary, prices);
    if (near === null || perToken <= 0 || summary.total.usd <= 0) return [];
    const called = new Set(Object.keys(summary.bySkill).map(bare));
    const listed = Object.entries(near.snap.skills).map(([name, tokens]) => ({ name, tokens, usd: tokens * perToken, used: called.has(bare(name)) }));
    const catalogUsd = listed.reduce((n, s) => n + s.usd, 0);
    const used = listed.filter((s) => s.used).length;
    if (listed.length === 0 || catalogUsd < SKILL_CATALOG_MIN_USD || catalogUsd / summary.total.usd <= SKILL_CATALOG_MIN_SHARE || used / listed.length >= SKILL_USED_MAX_SHARE) return [];
    const idle = listed.filter((s) => !s.used).sort((a, b) => b.usd - a.usd || (a.name < b.name ? -1 : 1));
    const usd = idle.reduce((n, s) => n + s.usd, 0);
    const evidence: Evidence[] = idle.slice(0, LISTED).map((s) => ({ label: "Never called", detail: `${s.name}: ${tokensText(s.tokens)} tokens, ${usdText(s.usd)}`, kind: "text" }));
    evidence.push(...proxyNote(near));
    return [
      {
        rule: "skill-catalog-heavy",
        title: "Skill list carried on every request, mostly unused",
        usd,
        summary: `The skill list is ${listed.length} entries long and costs ${usdText(catalogUsd)} to re-read across the span, yet just ${used} of ${listed.length} skills were ever called. The ${idle.length} that were not account for ${usdText(usd)}.`,
        action: "Uninstall or disable the plugins whose skills you never reach for, and for your own skills set disable-model-invocation in the front matter so they leave the list but stay available by name.",
        evidence,
        short: `${idle.length} of ${listed.length} listed skills never called`,
      },
    ];
  },
};
