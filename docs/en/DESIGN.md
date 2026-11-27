# tally design

How tally is built and why. The README covers what it does; this page covers the parts you need to know before changing the code.

## Goals and limits

- Run inside Claude Code's plugin engine with no runtime to install: no Node, Bun, Python or binary. Windows, macOS and Linux share one code base.
- Never hold up the session. A scan never blocks a prompt, and the first read of a large history shows partial numbers instead of waiting or failing.
- Keep private data on the machine that produced it. The only network request is the price page.
- Out of scope: other agents (Codex, Cursor), a team dashboard or server, a per-subagent context breakdown, Batch and data-residency pricing.

The engine sets the hard limits the design works around:

| Limit | Consequence |
| --- | --- |
| `fs.read` returns at most 4 MiB per call, with byte offsets | Files are read in chunks that stop at whole lines |
| `fs.write` writes at most 4 MiB per file, is not atomic, and has no rename, append or delete | The index writes new generations and commits them with a small pointer file |
| An event hook that loops without yielding crashes the worker | Every scan step runs in a slice of about 50 ms of CPU, then awaits |
| `$.process` exists only in the CLI | Git sync runs only from the CLI |
| `$.http.fetch` is limited to 30 s and 4 MiB | Enough for the price page |

## Layout

```text
.claude-plugin/    plugin.json, marketplace.json
hooks/             hooks.json and register.tsx, the only file that calls on(...)
core/              pure functions: parsing, dedupe, aggregation, pricing, rules, formatting
engine/            adapters over `$`: scanning, index storage, lease, price update, sync, live tally
view/              tabs, fold line, desktop row, compact and short layouts
report/            spend report generation
herdr/             Herdr sidebar resources
skills/            spend-optimize
tests/             claude plugin test; fixtures are synthetic
```

`core/` has no access to `$`, so every rule and formula is a function you can call in a test with plain data. `engine/` is the only place that touches the filesystem, clock, store and network. If a heavier scanner is ever needed outside the engine, `core/` moves over unchanged.

## Scanner

**Discovery.** Roots are `$CLAUDE_CONFIG_DIR/projects` or `<home>/.claude/projects`, plus the Claude desktop app's local session folders when they exist. Home is `HOME`, with `USERPROFILE` as the fallback on Windows. Paths go through `core/path`, which accepts `/` and `\`. `audit.jsonl` files are skipped.

**Order.** After `session.start`, a timer starts the scan so the hook returns first. Work runs in priority order: the project of the current session, then the last 24 hours, then 30 days. Each step updates a progress record, and the window shows it ("42% read, numbers still growing"). There is no timeout that turns a slow first read into a failure.

**Slicing.** A slicer tracks CPU time since the slice began and yields with `$.clock.sleep(0)` once 50 ms are used. It is checked between chunks, lines and shard writes. Tests drive it with an injected clock.

**Chunked reads.** Each read asks for up to 4 MiB as text. A range can cut a multi-byte character in two, so the reader keeps only whole lines: the partial last line, including any replacement character at the cut, is dropped and the offset advances by the byte length of the lines kept. A single line larger than a chunk is parsed by a separate oversized-line path.

**Incremental updates.** For each file the index stores size, mtime and the byte offset reached (always at a line end). Unchanged files are skipped, grown files continue from the offset, shrunk files are read again, and files outside the window are trimmed. `fs.list` already returns size and mtime, so nothing is statted per file.

**Parsing rules.**

- Requests are deduplicated by request id, keeping the row with the largest output. When the same id appears in two files, the first file owns it, except that a subagent file wins over the main file for attribution.
- Synthetic rows are not priced and not counted as requests.
- Subagents are recognized by path and by their `meta.json`.
- Cache lifetime comes from the actual 5-minute and 1-hour write split of each request, so a mixed write is not misread as a rebuild.
- A repository is the working directory name; a git worktree belongs to its host repository.

## Index

The index is split by project and then by UTC day:

```text
<config>/tally/index/<project-key>/            manifest and HEAD pointer
<config>/tally/index/<project-key>/d-<date>/   one day: rows by timestamp, file states, meta rows
```

- A project key is a sanitized prefix of the project name plus a 16-hex-digit hash, safe on Windows.
- Each bucket is stored in two generation slots, A and B, of parts under 3.5 MiB. A save writes the new generation into the slot not in use, then updates the small `HEAD.json` pointer. A reader that finds a part from another save, or a missing part, treats the slot as invalid and uses the other one.
- A save writes the changed day buckets first and the project manifest last. The manifest records the save counter of every bucket it expects, so a reader gets exactly the generations one save produced, never a mix of two. A damaged bucket makes only that project reload from transcripts.
- Only the current day's bucket is rewritten in steady state, about 1 to 2 MB on the measured machine. Steady-state saves for one project are at least 5 minutes apart.
- Prompt text keeps its first 200 characters. Metadata keeps the latest value per session and key. Session ids, directories, models and object keys are stored once in per-chunk string tables.
- Encoding and decoding yield between chunks and between part files.

**Versioning.** `INDEX_FORMAT` (currently 2) stamps the manifest. Raise it whenever the parser starts recording a field that existing transcripts would lack. An index with another stamp is dropped and read again from the transcripts; there is no migration code. The shard format itself has its own `v` field.

**Breakdown snapshots.** `$.session.usage({ breakdown })` works only for the running main session. Each live session saves a snapshot (skills, MCP tools, agents and memory files, each with token counts and deferred flags) into the index by session id and date. For history without a snapshot, the nearest one in time stands in and numbers drawn from it are marked `*`. Rules that need a breakdown still fire on a stand-in, and their evidence says which day's snapshot was used.

## Lease

Several Claude Code sessions can run on one machine, and only one should scan. The holder writes `<config>/tally/lease.json` with its session id and a heartbeat time.

- Acquire: read the file; if another session holds it with a heartbeat under 90 s old, stay read-only. Otherwise write your id, wait 300 ms and read it back. The last writer wins, and a session that finds another id leaves the lease alone. This stands in for an atomic create, which the filesystem API does not offer.
- Heartbeat every 30 s. A session that finds another id in the file has lost the lease and stops writing.
- Release writes an empty holder, because there is no delete. An empty holder reads as free.
- A crashed holder is replaced once its heartbeat is stale.

Sessions without the lease read the index and the progress file and show the same numbers. They write nothing to the index.

## Pricing

- A built-in table covers every current Claude model: input, output, cache read, cache write for 5 minutes (1.25 times input) and 1 hour (2 times input), the fast-mode multiplier and the long-context tier.
- Every 7 days, `$.http.fetch` gets `https://platform.claude.com/docs/en/about-claude/pricing.md`, parses the markdown tables and stores the result in `$.store`.
- A fetched table replaces the current one only if it keeps at least 80% of the current models and every price is positive and consistent (the 5-minute write price must be about 1.25 times input). Otherwise the old table stays and Help shows the error.
- After a failed attempt the next one waits 6 hours, so an offline machine does not retry on every session.
- Help shows the price source, the update date and any unpriced models. An unknown Claude model uses the latest price of its family and is marked `*`; a model from another vendor is listed as unpriced.
- `priceUpdate` set to false skips the request entirely.

## Live session

Per step, tally counts usage from `turn.step`, reads context, cost and limits from `$.session.usage()`, and follows `/clear`, `/resume` and `/branch` inside one process. Compaction is detected when the message count drops. The cache timer is checked against the latest cache write in the index to decide between the 1-hour and 5-minute lifetime. The cost of earlier launches of a resumed session comes from the index.

## Multi-machine sync

With `syncDir` set, after each scan tally writes one file, `<syncDir>/tally/<machineName>.json` (under 4 MiB), and reads the files of the other machines.

- The file holds UTC hourly buckets. At `numbers` level each bucket has the four token kinds, cost, model, main or subagent, subagent type by model and fast. `repos` adds per-repository buckets. `full` adds session titles, top sessions, context fill by tool and each machine's hint results with evidence.
- Repository aliases are an HMAC of the repository name with a salt kept in `<syncDir>/tally/salt`. The first machine creates the salt and every machine reads it, so aliases match across machines.
- Days are stored in UTC and shown in the viewer's local time zone.
- Transcripts stay on the machine that made them, so no request is counted twice.
- If `syncDir` is a git repository, tally runs `git pull --rebase` before and `git commit` and `git push` after a write, through `$.process.run`. Failures are logged only. In the desktop app and VS Code this step is skipped and the next CLI session pushes.
- Blocks that cannot be merged at the chosen level show "this machine only" in the all-machines view.

## Report and Herdr

The `tally_report` tool takes `days`, `repo`, `compare` and `saveBaseline` and returns the report that the `spend-optimize` skill uses. `/tally report` writes the same report as a markdown file. Reports redact commands to the program name, blank titles and keep only file names in paths.

After each scan, tally writes 24-hour and 30-day report snapshots to `<config>/tally/report-<span>.json`. The Herdr sidebar only reads and draws those files and shows how old they are; it bundles none of `core/`. With no Claude Code session running, it shows the last snapshot. Turning `herdrSidebar` off removes the folder tally created, identified by a marker file.

## Hint adoption and recheck

Adopting a hint stores the rule's metric, the expected saving and the date. A rule can provide a before-and-after metric, for example cache-rebuilt uses rebuild cost per active hour and fast-mode uses the fast cost share. After `recheckDays` (default 14), a toast reminds you and the Hints tab shows expected against actual saving. Rules without a metric record the adoption and nothing else. Low-confidence model-change hints say "try it" and never "downgrade".

## Privacy invariants

These hold for every change; a change that breaks one needs a README and SECURITY.md update in the same pull request.

1. tally writes no transcript file.
2. The only network request is the price page, at most weekly, and `priceUpdate` turns it off. Git sync talks to the user's own remote.
3. Without a raised `shareDetail`, no repository name, session title, path or command leaves the machine.
4. Fixtures and examples contain synthetic data only.

## Verification

- Tests run with `claude plugin test`. Pure functions and the window share one setup. All transcript fixtures are synthetic.
- Accuracy: over the same 30 local days on one machine, tally and ccusage totals differed by 0.003%, and no single day differed by more than 0.3%. The method and the definitional differences (window edges, synthetic rows, rows from other agents) are in [scripts/compare.md](../../scripts/compare.md).
- Performance on that machine, with 30 days of history of about 8.3 GB in 82,000 files: cold scan 84 to 89 s, warm start about 9 s with no transcript bytes read, incremental update under 5 s, 96.7 MB of index (about 1.2% of the transcripts). Splitting the index by day cut its size after a cold scan from 493 MB to 96.7 MB. Typing latency during a scan has not been measured by hand.
- CI runs `claude plugin validate .` and `claude plugin test .` on macOS, Windows and Ubuntu.
