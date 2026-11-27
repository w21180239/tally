# Changelog

Release notes are cut from this file. Newest first.

## 0.1.0

First release.

- Window with six tabs (Session, Usage, Context, History, Hints, Help), a foot with cache timers and limits, four layouts, a fold line above the prompt, a desktop info row and a VS Code view.
- Zero runtime dependencies; Windows, macOS and Linux from one code base, tested in CI on all three. Windows is covered by CI; manual testing on a real Windows machine is pending.
- Background scan of 30 days of transcripts in 50 ms slices with chunked reads, an on-disk index split by UTC day with two generation slots, and a lease so only one session per machine scans.
- Price table with cache write for 5 minutes and 1 hour, fast mode and the long-context tier, refreshed weekly from the Anthropic pricing page. `priceUpdate` turns the request off.
- Hints with evidence, adoption with `y`, and a recheck after `recheckDays` that shows expected against actual saving.
- Multi-machine totals through `syncDir`, with `numbers`, `repos` and `full` sharing levels and repository aliases for the default level.
- `/tally report`, the `tally_report` tool and the `spend-optimize` skill; optional Herdr sidebar.
- Settings: `priceUpdate`, `syncDir`, `machineName`, `shareDetail`, `redactEvidence`, `recheckDays`, `open`, `money`, `decimals`, `desktopRow`, `herdrSidebar`.
