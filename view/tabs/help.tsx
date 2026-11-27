// The Help tab: sources of the figures, a legend for colours and keys, the settings with their current values, the
// price table's provenance and the version. `drawHelp` returns the rows; the tab adds no keys.
import type { RenderElement } from "claude-code";
import { PRICING_URL } from "../../engine/price-update.ts";
import type { PriceError } from "../../engine/price-update.ts";
import type { PriceTable } from "../../core/pricing.ts";
import { SETTING_KEYS } from "../../core/settings.ts";
import type { Settings } from "../../core/settings.ts";
import type { HelpData } from "../../engine/help-view.ts";
import type { KeyCtx } from "../keys.ts";
import { blank, title } from "../rows.tsx";
import type { Table } from "../table.ts";
import { CACHE_MARK, HINT_MARK, HOT_SHARE, WARN_SHARE } from "../theme.ts";

/** Unpriced models listed before the rest are counted. */
export const UNPRICED_ROWS = 10;
const NAME_CELLS = 16;
const VALUE_CELLS = 22;
const KEY_CELLS = 14;
const LEGEND_CELLS = 8;

export type HelpInput = {
  settings: Settings;
  /** The table in effect. */
  prices: PriceTable;
  /** The last failed price update, when there is one. */
  priceError?: PriceError;
  data: HelpData;
};

export type HelpDrawing = { rows: RenderElement[]; ctx: KeyCtx };

const PRICING_PAGE = PRICING_URL.replace(/^https:\/\//, "");

/** A day as `YYYY-MM-DD` in UTC. */
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const percent = (share: number): string => `${Math.round(share * 100)}%`;

const SOURCES = [
  "Transcripts: the session files in your Claude config folder, read by a background scan. tally never writes a transcript.",
  "Index: tally's own copy of each request's token counts, kept beside the config. The History, Usage and Hints tabs read it.",
  "This session: counted live as each request finishes, so Session shows it before the index does.",
  "Prices: a built-in table, refreshed weekly from the Anthropic pricing page unless priceUpdate is off. That page is the only network call tally makes.",
  "Amounts are list-price API equivalents of your token use, not an invoice.",
];

const KEYS: Array<[string, string]> = [
  ["0-5", "jump to a tab by its number; Help is 0"],
  ["s", "time span (Usage and Hints)"],
  ["r", "all repos or the current repo (History and Hints)"],
  ["t", "this machine or all computers (with a sync folder)"],
  ["a, p, n", "pick an agent, then step to the previous or next (Usage, Context)"],
  ["v", "open the chosen agent's transcript (Context); full row text (Usage)"],
  ["b", "back from a transcript"],
  ["m", "show the cut lists whole"],
  ["tab, enter", "walk the rows and open one"],
  ["esc", "collapse the window to one line"],
  ["ctrl+x, tab", "hand the keyboard to the window"],
  ["/tally", "open the window; add a tab name or a span, or set an option like money dollars"],
];

const SETTING_NOTES: Record<keyof Settings, string> = {
  priceUpdate: "fetch current prices weekly",
  syncDir: "git-synced folder for sharing totals between machines",
  machineName: "this machine's label in shared totals; empty uses the hostname",
  shareDetail: "how much shared totals reveal: numbers, repos or full",
  redactEvidence: "strip prompt and file text from hint evidence",
  recheckDays: "days before a dismissed hint is checked again",
  open: "fold on the first message, stay open, or open only via /tally",
  money: "unit of amounts: mixed, cents or dollars",
  decimals: "auto trims zeros; 0-4 fixes the places",
  desktopRow: "summary line over the prompt, desktop app only",
  herdrSidebar: "also write the report to a Herdr sidebar",
};

function valueText(v: Settings[keyof Settings]): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  return v === "" ? "(unset)" : String(v);
}

export function drawHelp(t: Table, i: HelpInput): HelpDrawing {
  const { Box, Text } = t;
  const { settings, prices, priceError, data } = i;
  const out: RenderElement[] = [];
  const line = (key: string, text: string, tone?: "warning"): void => {
    out.push(
      <Box key={key} paddingLeft={2}>
        <Text {...(tone === undefined ? { dimColor: true } : { color: tone })}>{text}</Text>
      </Box>,
    );
  };
  const pair = (key: string, left: string, cells: number, right: string): void => {
    out.push(
      <Box key={key} flexDirection="row" columnGap={1} paddingLeft={2}>
        <Box width={cells} flexShrink={0}>
          <Text>{left}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor>{right}</Text>
        </Box>
      </Box>,
    );
  };

  out.push(title(t, "sources", "Data sources"));
  SOURCES.forEach((s, n) => line(`source-${n}`, s));
  out.push(blank(t, "sources"));

  out.push(title(t, "colours", "Colours"));
  const legend: Array<[string, "success" | "warning" | "error" | "claude", string]> = [
    ["green", "success", `under ${percent(WARN_SHARE)} of a window or budget used`],
    ["amber", "warning", `${percent(WARN_SHARE)} up to ${percent(HOT_SHARE)} used`],
    ["red", "error", `${percent(HOT_SHARE)} or more used`],
    ["orange", "claude", "the main share in a bar"],
  ];
  for (const [name, color, meaning] of legend) {
    out.push(
      <Box key={`colour-${name}`} flexDirection="row" columnGap={1} paddingLeft={2}>
        <Box width={LEGEND_CELLS} flexShrink={0}>
          <Text color={color}>{name}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor>{meaning}</Text>
        </Box>
      </Box>,
    );
  }
  pair("colour-dim", "dim", LEGEND_CELLS, "secondary labels and figures");
  pair("colour-hint", HINT_MARK, LEGEND_CELLS, "a hint was found");
  pair("colour-cache", CACHE_MARK, LEGEND_CELLS, "time left before the prompt cache expires");
  out.push(blank(t, "colours"));

  out.push(title(t, "keys", "Keys"));
  KEYS.forEach(([key, meaning], n) => pair(`key-${n}`, key, KEY_CELLS, meaning));
  out.push(blank(t, "keys"));

  out.push(title(t, "settings", "Settings", "change them in the plugin menu or with /tally <name> <value>"));
  for (const key of SETTING_KEYS) {
    out.push(
      <Box key={`setting-${key}`} flexDirection="row" columnGap={1} paddingLeft={2}>
        <Box width={NAME_CELLS} flexShrink={0}>
          <Text>{key}</Text>
        </Box>
        <Box width={VALUE_CELLS} flexShrink={0}>
          <Text weight="bold">{valueText(settings[key])}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor>{SETTING_NOTES[key]}</Text>
        </Box>
      </Box>,
    );
  }
  out.push(blank(t, "settings"));

  out.push(title(t, "prices", "Prices"));
  const source = prices.source === "builtin" ? `built-in (${isoDay(prices.updatedAt)})` : `fetched ${isoDay(prices.updatedAt)} from ${PRICING_PAGE}`;
  out.push(
    <Box key="prices-source" paddingLeft={2}>
      <Text>{`Prices: ${source}`}</Text>
    </Box>,
  );
  line("prices-size", `${Object.keys(prices.models).length} models, fast mode ${prices.fastMul}x`);
  if (!settings.priceUpdate) line("prices-off", "Online update is off (priceUpdate): prices change only when tally does.");
  if (priceError !== undefined) line("prices-error", `Last price update failed (${isoDay(priceError.at)}): ${priceError.message}`, "warning");

  if (data.ready) {
    if (data.unpriced.length === 0) line("unpriced-none", "Every model in recent history has a price.");
    else {
      line("unpriced-note", "These models have no price and are counted as $0:");
      for (const m of data.unpriced.slice(0, UNPRICED_ROWS)) {
        out.push(
          <Box key={`unpriced-${m}`} paddingLeft={4}>
            <Text>{m}</Text>
          </Box>,
        );
      }
      if (data.unpriced.length > UNPRICED_ROWS) line("unpriced-more", `${data.unpriced.length - UNPRICED_ROWS} more`);
    }
    if (data.unread > 0) line("unpriced-unread", `${data.unread} ${data.unread === 1 ? "project is" : "projects are"} not indexed yet; their models are not listed.`);
  } else if (data.failure !== undefined) {
    line("unpriced-failed", `Could not list unpriced models: ${data.failure.why}`);
  } else {
    line("unpriced-loading", "Looking for models without a price...");
  }
  out.push(blank(t, "prices"));

  out.push(title(t, "version", "Version"));
  out.push(
    <Box key="version-text" paddingLeft={2}>
      <Text>{data.version === "" ? "tally (version unknown)" : `tally ${data.version}`}</Text>
    </Box>,
  );
  return { rows: out, ctx: {} };
}
