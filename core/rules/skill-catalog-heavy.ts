import { nearestSnapshot } from "../breakdown.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { DEFAULT_WINDOW, LISTED, proxyNote, residentUsdPerToken, tokensText, usdText } from "./shared.ts";

/** The skill listing's budget as a share of the context window; descriptions past it are dropped, least-used skills first. */
export const SKILL_LISTING_SHARE = 0.01;

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
  run: ({ summary, snaps, prices, live, window }) => {
    const near = nearestSnapshot(snaps, summary.to, live?.sessionId);
    const perToken = residentUsdPerToken(summary, prices);
    if (near === null || perToken <= 0 || summary.total.usd <= 0) return [];
    const called = new Set(Object.keys(summary.bySkill).map(bare));
    const entries = Object.entries(near.snap.skills);
    // The listing is capped at a share of the window; past it descriptions are dropped, so the carried cost stops growing.
    const listedTokens = entries.reduce((n, [, tokens]) => n + tokens, 0);
    const cap = SKILL_LISTING_SHARE * (window ?? DEFAULT_WINDOW);
    const scale = listedTokens > cap ? cap / listedTokens : 1;
    const listed = entries.map(([name, tokens]) => ({ name, tokens, usd: tokens * scale * perToken, used: called.has(bare(name)) }));
    const catalogUsd = listed.reduce((n, s) => n + s.usd, 0);
    const used = listed.filter((s) => s.used).length;
    if (listed.length === 0 || catalogUsd < SKILL_CATALOG_MIN_USD || catalogUsd / summary.total.usd <= SKILL_CATALOG_MIN_SHARE || used / listed.length >= SKILL_USED_MAX_SHARE) return [];
    const idle = listed.filter((s) => !s.used).sort((a, b) => b.usd - a.usd || (a.name < b.name ? -1 : 1));
    const usd = idle.reduce((n, s) => n + s.usd, 0);
    const evidence: Evidence[] = idle.slice(0, LISTED).map((s) => ({ label: "Never called", detail: `${s.name}: ${tokensText(s.tokens)} tokens, ${usdText(s.usd)}`, kind: "text" }));
    if (scale < 1) evidence.push({ label: "Listing budget", detail: `${tokensText(listedTokens)} tokens of listings against a budget of ${tokensText(cap)}; descriptions past it are dropped`, kind: "text" });
    evidence.push(...proxyNote(near));
    return [
      {
        rule: "skill-catalog-heavy",
        title: "Skill list carried on every request, mostly unused",
        usd,
        summary: `The skill list is ${listed.length} entries long and costs ${usdText(catalogUsd)} to re-read across the span, yet just ${used} of ${listed.length} skills were ever called. The ${idle.length} that were not account for ${usdText(usd)}.`,
        action: `Shrink the list · run /skill-doctor to see each skill's cost and use. Disable the plugins whose skills you never reach for; for your own skills set "name-only" in skillOverrides to keep the name and drop the description, or disable-model-invocation in the front matter to remove the entry.${scale < 1 ? " Descriptions of the least-used skills are already being dropped past the budget, which weakens matching for them." : ""}`,
        evidence,
        short: `${idle.length} of ${listed.length} listed skills never called`,
      },
    ];
  },
};
