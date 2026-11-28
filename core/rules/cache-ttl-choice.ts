import type { Evidence, HintRule } from "../hint.ts";
import { usdText } from "./shared.ts";

/** Floor on how much cheaper the other life replays, in dollars and as a fraction of the cost with the life in use. */
export const TTL_MIN_USD = 1;
export const TTL_MIN_SHARE = 0.1;

const NAME = { "5m": "5-minute", "1h": "1-hour" } as const;

export const cacheTtlChoice: HintRule = {
  id: "cache-ttl-choice",
  run: ({ summary }) => {
    const m = summary.cacheTtl;
    const now = m.actual;
    const other = now === "5m" ? "1h" : "5m";
    const cost = { "5m": m.usd5m, "1h": m.usd1h };
    const saving = cost[now] - cost[other];
    if (m.requests === 0 || cost[now] <= 0 || saving < TTL_MIN_USD || saving / cost[now] < TTL_MIN_SHARE) return [];
    const { short, mid, long } = m.pauses;
    const evidence: Evidence[] = [
      { label: "Pauses", detail: `${short} under 5 minutes, ${mid} from 5 minutes to 1 hour, ${long} over 1 hour`, kind: "text" },
      { label: "5-minute cache", detail: `${usdText(m.usd5m)} replayed at list price`, kind: "text" },
      { label: "1-hour cache", detail: `${usdText(m.usd1h)} replayed at list price`, kind: "text" },
    ];
    return [
      {
        rule: "cache-ttl-choice",
        title: "A different cache lifetime would cost less",
        usd: saving,
        projected: true,
        summary: `Replaying ${m.requests} main-conversation pauses (${short} under 5 minutes, ${mid} up to an hour, ${long} longer; sub-agent requests left out) with a ${NAME[other]} cache puts cache traffic at ${usdText(cost[other])}, against ${usdText(cost[now])} on the ${NAME[now]} cache you use: ${usdText(saving)} less. On a subscription within plan usage these are list-price equivalents, not charges.`,
        action:
          other === "1h"
            ? "Keep the cache warm through pauses · set promptCacheTtl to 1h (or CLAUDE_CODE_PROMPT_CACHE_TTL=1h). Writes cost more, but a pause of 5 to 60 minutes then finds the cache still warm. ENABLE_PROMPT_CACHING_1H=1 covers sub-agents too, and subagentPromptCacheTtl sets them alone."
            : "Use the shorter cache · set promptCacheTtl to 5m (or FORCE_PROMPT_CACHING_5M=1). Your pauses are mostly short, or longer than an hour whichever life is set, so the higher price of 1-hour writes does not pay for itself.",
        evidence,
        short: `${NAME[other]} cache would save ${usdText(saving)}`,
      },
    ];
  },
};
