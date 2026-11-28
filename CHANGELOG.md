# Changelog

Release notes are cut from this file. Newest first.

## Unreleased

- The Usage tab on the session span now fills from the live session, so a new session no longer reads "No requests" while the Session tab already shows cost; it refreshes every 10 seconds, and the index's own rows take over once it has caught up.
- Hints worth under a cent are no longer listed, and their amounts follow the shared money format (cents under a dollar). tally no longer reports itself as an unused plugin or MCP server.
- `/tally` accepts `tokens` (Usage), `settings` (Help), `money both|dollar|cent|dollars only` and `row show|hide`. Command errors give the concrete usage and the allowed values.
- `/tally report <repo>` for a repository with no requests writes no file and names the repositories that have data.
- Folded line: parts are ordered by importance (`session` cost, context, cache, chart, hint), every amount has a word (`session $1.16`, `save ~$0.03`), and the line gives way from the right as the width shrinks. On the main screen it ends with `ctrl+x tab, enter or /tally: open` until you open the window from it once. A focused line is drawn without tone colours.
- One word per concept: `expired` replaces `cold`, `rewrite cost` replaces `refill`, `sub-agent` replaces `subagent`; the desktop row's button reads `details ▸` and its hint amount reads `save ...`.
- The cache countdown shows whole minutes and `<1m` instead of seconds.
- The recheck toast names the hint's title and follows the `money` and `decimals` settings (`tally: Cache expired while idle: expected save $7.13, actual $5.80`).
- README and docs: key and word tables (English and Chinese), `/tally close` and `PgUp`/`PgDn` scrolling.

- Fixed the window coming back every session after it was closed: a fold the store refused (a locked file on Windows, a full disk) is now logged and written again, and the person's close always counts. The pane has a fold button, and on the main screen, where Claude Code reports no clicks, the folded line names `/tally to open`.

## 1.0.0 - 2026-11-28

First release.

- Window with six tabs (Session, Usage, Context, History, Hints, Help), a foot with cache timers and limits, four layouts, a fold line above the prompt, a desktop info row and a VS Code view.
- Zero runtime dependencies; Windows, macOS and Linux from one code base, tested in CI on all three. Windows is covered by CI; manual testing on a real Windows machine is pending.
- Background scan of 30 days of transcripts in 50 ms slices with chunked reads, an on-disk index split by UTC day with two generation slots, and a lease so only one session per machine scans.
- Price table with cache write for 5 minutes and 1 hour, fast mode and the long-context tier, refreshed weekly from the Anthropic pricing page. `priceUpdate` turns the request off.
- Hints with evidence, adoption with `y`, and a recheck after `recheckDays` that shows expected against actual saving.
- Multi-machine totals through `syncDir`, with `numbers`, `repos` and `full` sharing levels and repository aliases for the default level.
- `/tally report` (writes `api-spend-<date>.md` in the working folder), `/tally sync`, the `tally_report` tool and the `spend-optimize` skill, which shows each change and asks before it edits a configuration file; optional Herdr sidebar.
- Prices resolve Bedrock and Vertex model ids and the Mythos family; a fetched price table is merged over the built-in one and checked column by column.
- Checked against ccusage over 30 local days: within 0.010% on the total and within 0.03% per model (`scripts/compare.md`).
- Settings: `priceUpdate`, `syncDir`, `machineName`, `shareDetail`, `redactEvidence`, `recheckDays`, `open`, `money`, `decimals`, `desktopRow`, `herdrSidebar`.
