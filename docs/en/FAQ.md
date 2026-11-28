# FAQ and troubleshooting

## Install and start

**`/tally` says the command does not exist.** Restart Claude Code or run `/reload-plugins`, then run `/plugin` and check that `tally` is enabled. Check `claude --version`: tally needs 2.1.326 or later.

**The marketplace add fails.** Run `claude plugin marketplace add w21180239/tally` in a shell to see the full error. A proxy that blocks `github.com` blocks the clone; add the repository from a local clone instead: `git clone https://github.com/w21180239/tally` then `claude plugin marketplace add ./tally`.

**How do I install on Windows?** Install Claude Code (`irm https://claude.ai/install.ps1 | iex` in PowerShell), then run the same two `claude plugin` commands as on any other platform.

**Is Windows supported?** Windows is covered by CI; manual testing on a real Windows machine is pending.

**How do I remove it?** `claude plugin uninstall tally@tally` and `claude plugin marketplace remove tally`. tally's own data is in `<config>/tally/`, where `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`. Delete that folder to remove it. If you used `syncDir`, the `tally/` folder inside it is yours to delete too.

## Numbers

**Why are the numbers still growing after I opened the window?** The first scan reads up to 30 days of transcripts in the background. The window shows how much has been read. On the measured machine (about 8.3 GB of history) a cold scan took 84 to 89 seconds; later starts read only what changed.

**Is this my bill?** No. Amounts are API-equivalent: the usage at list prices. A subscription is billed differently, so use tally to see where usage goes and how it compares across sessions, models and days.

**Why does a number have a `*`?** The value is an estimate. Either the model is unknown and uses the latest price of its family, or a context breakdown came from the nearest saved snapshot because the session is not running now.

**Why do tally and another tool differ?** Tools cut their windows differently (rolling 30 days against whole local days), and some also read other agents' logs. Compare whole local days. [scripts/compare.md](../../scripts/compare.md) has the steps and the known definitional differences.

**A model shows as unpriced.** Models that are not Anthropic's have no price in the table. Their requests are listed, and their cost is left out of the totals. Help shows the list.

**Fast mode, long-context and cache prices.** The table includes the fast-mode multiplier, the long-context tier and cache write for 5 minutes and 1 hour. Batch and data-residency pricing are not covered, because transcripts carry no signal for them.

## Hints

**A hint looks wrong for my case.** Open its evidence on the Hints tab (`tab`/`enter`). Each hint shows the numbers it was computed from. If the numbers are right and the advice does not fit, open an issue with the rule name and the figures, with private text removed.

**What does `y` do?** It adopts the hint: tally stores the rule's metric, the expected saving and the date. After `recheckDays` a toast shows the hint's title with expected against actual saving (`tally: Cache expired while idle: expected save $7.13, actual $5.80`), written in your `money` and `decimals` format, for rules that have a before-and-after metric.

**How do I reach the folded line on the main screen?** Claude Code reports no clicks there. Press `ctrl+x`, then `tab` to focus the line and `enter` to open the window, or run `/tally`. The line says so until you have opened the window from it once.

**What do `expired` and `rewrite cost` mean?** `expired`: the prompt cache ran out while you were away, so the next request writes the context again. `rewrite cost` is the price of that write. The countdown shows whole minutes (`4m`, then `<1m`), not seconds.

**What are the keys for closing and scrolling?** `esc` or `/tally close` fold the window. `PgUp` and `PgDn` scroll a docked window.

**Can I hide titles and commands from the window?** Set `redactEvidence` to true. Commands keep only the program name, titles are blank and paths keep only the file name.

## Several machines

**How do I set up sync?** On each machine set `syncDir` to a folder that something already syncs (a private git repository, OneDrive, iCloud, Syncthing) and give each machine a different `machineName`. Press `t` on Spend or Hints to switch between this computer and all computers.

**What leaves my machine?** At the default `shareDetail` of `numbers`: hourly totals by model with token counts and cost, and repositories only as irreversible aliases. `repos` adds names; `full` adds session titles and hint evidence. Keep any machine whose repository names or titles are private at `numbers`.

**Git sync does nothing in the desktop app.** `$.process` is available only in the CLI, so the git step is skipped elsewhere. The next CLI session pushes.

**Two machines show different totals for the same day.** Days are stored in UTC and shown in your local zone, and each machine contributes only the transcripts it holds. A machine that has not synced since a session ran is behind until its next push.

## Performance

**Does it slow Claude Code down?** The scan runs in slices of about 50 ms of CPU with a yield between slices. On the measured machine a cold scan took 84 to 89 seconds, a warm start about 5 seconds (up to about 13 under heavy machine load) and an incremental update under 5 seconds. Typing latency during a scan has not been measured by hand; if you notice lag, open an issue with `/tally debug` output.

**How much disk does it use?** About 1.2% of the transcript size on the measured machine (96.7 MB for 8.3 GB). The index lives in `<config>/tally/index/` and is safe to delete; the next start rebuilds it.

**Two Claude Code sessions are open. Do they scan twice?** No. One session holds a lease and scans; the others read the index. If the holder exits or crashes, another takes over after the heartbeat goes stale (90 seconds).

## Privacy

**Does tally send my transcripts anywhere?** No. It writes no transcript and makes one request, to the Anthropic pricing page, at most weekly. Set `priceUpdate` to false for none at all.

**Where are the files?** `<config>/tally/` holds the index, the lease, progress and report snapshots. `/tally report` writes `api-spend-<date>.md` in the folder Claude Code is working in; a report from the same day overwrites the earlier one, and it lists repository names. With `syncDir` set, `<syncDir>/tally/` holds one totals file per machine and the alias salt.

## Troubleshooting data

`/tally debug` prints scan progress and totals; `/tally debug --json` prints them as JSON, including totals by model and by day. Attach the output (with private text removed) to a bug report.

If the index looks damaged, delete `<config>/tally/index/` and start a new session. tally rebuilds it from your transcripts.
