# Accuracy cross-check: tally vs ccusage

Compares the 30-day spend of two tools on one machine. Compare whole local days only: the two tools
cut their windows differently (see "Windows" below), and today's transcripts keep growing during the run.

## 1. Collect

Run both within a few minutes of each other.

tally (a cold index needs about 90 s to scan; poll `/tally debug` until `"phase":"done"`, then ask for the JSON):

    printf '%s\n' '{"type":"user","message":{"role":"user","content":"/tally debug"}}' \
      | claude -p --plugin-dir <tally> --input-format stream-json --output-format stream-json --verbose

The JSON reply (`/tally debug --json`) carries `total`, `byModel` and `byDay` (local calendar days, 30 buckets
ending today). Save the `result` text of that reply as `tally.json`.


ccusage:

    npx ccusage@latest daily --json --breakdown --since <YYYYMMDD of 31 days ago> --timezone <IANA zone>

`daily[]` carries `period` (local day), `totalCost` and `modelBreakdowns[]` (`modelName`, `cost`).

## 2. Compare

1. Take the 30 local days tally reports (`byDay[].day`). Sum each tool over exactly those days.
2. Pairwise difference = (a - b) / b. Target: at most 1% for every pair.
3. When over 1%, list days where any pair differs by more than 0.3%, then compare `byModel` over the same days.
   A cause in tally's parsing, dedupe or pricing is fixed with a test. A definitional difference
   (window edge, dedupe rule, a model's price, fast mode, ccusage's own pricing) goes into the accuracy notes with numbers.

## Windows

- tally: 30 local-day buckets, the first starts at a local midnight; the window ends now.
- ccusage: whole local days from `--since`.
