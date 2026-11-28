// Timers that keep the window's countdowns current.
import type { EngineInterface } from "claude-code";
import { readLive } from "./live.ts";
import { inBackground, invalidateWindow, refreshChart } from "./window.ts";

const MINUTE_MS = 60_000;
const COUNTDOWN_MS = 15_000;
const FIVE_MIN_MS = 300_000;
const LIFE_MS = { "5m": 300_000, "1h": 3_600_000 } as const;

/**
 * A redraw each minute (and the chart when due); each 15 s while main's cache has under 5 minutes left, so the last
 * minutes (shown whole as `4m`, then `<1m`) and the flip to expired land within 15 s. The countdown shows no seconds.
 */
export function startTimers($: EngineInterface): Array<{ cancel(): void }> {
  return [
    $.clock.every(MINUTE_MS, () => {
      invalidateWindow($);
      inBackground($, () => refreshChart($));
    }),
    $.clock.every(COUNTDOWN_MS, () => {
      inBackground($, async () => {
        const w = (await readLive($)).lastWrite;
        if (w === undefined) return;
        const left = w.ts + LIFE_MS[w.ttl] - (await $.clock.now());
        if (left > 0 && left < FIVE_MIN_MS) invalidateWindow($);
      });
    }),
  ];
}
