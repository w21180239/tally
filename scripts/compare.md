# Accuracy cross-check: tally vs ccusage

Compares the 30-day spend of tally and [ccusage](https://github.com/ryoppippi/ccusage) on one machine. Compare whole local days only: the two tools cut their windows differently (see "Windows" below), and today's transcripts keep growing during the run.

## 1. Collect

Run both within a few minutes of each other.

tally (a cold index needs about 90 s to scan; poll `/tally debug` until `"phase":"done"`, then ask for the JSON):

    printf '%s\n' '{"type":"user","message":{"role":"user","content":"/tally debug"}}' \
      | claude -p --plugin-dir <tally> --input-format stream-json --output-format stream-json --verbose

The JSON reply (`/tally debug --json`) carries `total`, `byModel` and `byDay` (local calendar days, 30 buckets ending today). Save the `result` text of that reply as `tally.json`.

ccusage:

    npx ccusage@latest daily --json --breakdown --since <YYYYMMDD of 31 days ago> --timezone <IANA zone>

`daily[]` carries `period` (local day), `totalCost` and `modelBreakdowns[]` (`modelName`, `cost`).

## 2. Compare

1. Take the 30 local days tally reports (`byDay[].day`). Sum each tool over exactly those days.
2. Difference = (tally - ccusage) / ccusage. Target: at most 1%.
3. When over 1%, list the days that differ by more than 0.3%, then compare `byModel` over the same days. A cause in tally's parsing, dedupe or pricing is fixed with a test. A definitional difference (window edge, dedupe rule, a model's price, fast mode, rows ccusage reads from other agents) is written down with its numbers.

## Results

Run on 2026-11-28 over the 30 local days from 2026-10-30 to 2026-11-28, one machine, both tools collected within a few minutes of each other.

| Comparison | Difference (tally against ccusage) |
| --- | --- |
| Total over the 30 days | within 0.010% |
| Each model over the same days | within 0.03% |

Both are far inside the 1% target. Window edges, the one known definitional difference, are described below.

## Windows

- tally: 30 local-day buckets, the first starts at a local midnight; the window ends now.
- ccusage: whole local days from `--since`.
