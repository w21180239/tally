import type { HintInput, HintRule } from "../hint.ts";
import { percentText, usdText } from "./shared.ts";

/** Cutoffs on fast-mode spend: its portion of total spend, and an absolute dollar floor. */
export const FAST_SHARE = 0.2;
export const FAST_MIN_USD = 1;

const fastShare = (i: HintInput): number => (i.summary.total.usd > 0 ? i.summary.fast.usd / i.summary.total.usd : 0);

export const fastMode: HintRule = {
  id: "fast-mode",
  metric: fastShare,
  run: (i) => {
    const { fast, total } = i.summary;
    const mul = i.prices.fastMul;
    if (total.usd <= 0 || fast.usd < FAST_MIN_USD || fastShare(i) <= FAST_SHARE || mul <= 1) return [];
    // Fast requests cost `mul` times the standard rate, so their standard-speed price is fast / mul.
    const saving = fast.usd - fast.usd / mul;
    return [
      {
        rule: "fast-mode",
        title: "Fast-mode surcharge",
        usd: saving,
        projected: true,
        summary: `Fast mode accounts for ${percentText(fastShare(i))} of spend (${usdText(fast.usd)}) at ${mul}x pricing; the same requests at standard speed would have cost ${usdText(saving)} less.`,
        action: "Toggle it with /fast: the premium pays off only while you are actively waiting on replies, so switch it off for anything you can leave running.",
        evidence: [{ label: "Fast requests", detail: `${usdText(fast.usd)} across ${fast.requests} ${fast.requests === 1 ? "request" : "requests"}`, kind: "text" }],
        short: `fast mode: ${percentText(fastShare(i))} of spend`,
        metric: { name: "fast share of cost", value: fastShare(i) },
      },
    ];
  },
};
