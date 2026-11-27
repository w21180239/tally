<div align="center">

<img src="./repo-assets/logo.svg" width="96" alt="tally logo">

# tally

**A Claude Code plugin that shows what your sessions cost in API-equivalent dollars, what the context is made of, and where you can spend less, on Windows, macOS and Linux with no dependencies.**

[Quick start](#quick-start) · [What you see](#what-you-see) · [Settings](#settings) · [Privacy](#privacy) · [Docs](./docs/README.md) · English | [简体中文](./README.zh-cn.md)

[![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg?style=flat)](#license)
[![CI](https://img.shields.io/github/actions/workflow/status/w21180239/tally/test.yml?branch=main&style=flat&label=CI)](https://github.com/w21180239/tally/actions/workflows/test.yml)
[![Stars](https://img.shields.io/github/stars/w21180239/tally.svg?style=flat)](https://github.com/w21180239/tally/stargazers)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.326-D97757.svg?style=flat)](#requirements)

</div>

tally reads the transcripts Claude Code already keeps on your disk and turns them into a window inside Claude Code: what this session cost, what the last 24 hours and 30 days cost, which models, repositories and subagents drove it, what sits in the context on every request, and a list of hints that each name the saving and show the evidence. Prices follow the official pricing page, and totals from several machines can be merged.

## Why

Some of what a Claude Code session spends goes where you cannot see it. A large `CLAUDE.md`, a long skill list or an unused MCP server is re-read on every request. A cache that expires during a pause is rebuilt at a higher price. A subagent on the largest model may only be reading files. The numbers are in your transcripts, but nobody reads 8 GB of JSONL by hand.

tally does the reading. It is built for people who use Claude Code every day and want to see where the money goes without leaving the session, installing a runtime or sending a transcript anywhere.

tally lives in Claude Code's plugin engine, so there is no Node, Bun, Python or binary to install. One code base serves Windows, macOS and Linux, and CI runs the test suite on all three.

A built-in price table covers every Claude model, including cache write for 5 minutes and 1 hour, fast mode and the long-context tier. It refreshes weekly from the official pricing page.

To get one total across several machines, point `syncDir` at a folder you already sync (a private git repository, OneDrive, iCloud, Syncthing). Each machine shares only its totals.

tally never writes to a transcript. Its one network call fetches the price page, and you can turn that off.

## How it works

<p align="center"><img src="./repo-assets/flow.svg" alt="Flow: transcripts are read in chunks, scanned in 50 ms slices into an index of day buckets on disk, and shown in the window, the report and the optional sidebar; the price table, a sync folder and the live session feed the numbers" width="100%"></p>

1. When a session starts, a background scan reads transcripts in chunks of at most 4 MiB, stopping at whole lines. It handles the current project first, then the last 24 hours, then 30 days, and the window shows progress while the numbers grow.
2. The scan runs in slices of about 50 ms of CPU with a yield between slices, so typing and prompts are never held up.
3. Results are saved as an index of day buckets under `<config>/tally/index/`. A later start reads just the files that changed.
4. If several Claude Code sessions run on one machine, one of them holds a lease and scans; the others read the index.
5. The window, the `/tally report` command and the optional Herdr sidebar all read from that index and from the live session.

The design is written up in [docs/en/DESIGN.md](./docs/en/DESIGN.md).

## Requirements

- Claude Code 2.1.326 or later. Developed on 2.1.332.
- Windows, macOS or Linux. `git` on your PATH only if you use git-based sync from the CLI.

## Quick start

Inside Claude Code:

```text
/plugin marketplace add w21180239/tally
/plugin install tally@tally
```

Or from a shell (macOS, Linux, or PowerShell on Windows):

```bash
claude plugin marketplace add w21180239/tally
claude plugin install tally@tally
```

From a local clone (macOS, Linux, or PowerShell on Windows):

```bash
git clone https://github.com/w21180239/tally.git
claude plugin marketplace add <path-to-clone>
claude plugin install tally@tally
```

Restart Claude Code or run `/reload-plugins`, then run:

```text
/tally
```

On Windows, install Claude Code first if you have not: `irm https://claude.ai/install.ps1 | iex` in PowerShell. The `claude plugin` commands above are the same on every platform.

Update with `claude plugin update tally` (restart to apply). Remove with:

```bash
claude plugin uninstall tally@tally
claude plugin marketplace remove tally
```

The first scan of a large history takes a minute or two (see [Performance](#performance)). You can use the window while it runs.

## What you see

`/tally` opens a window with six tabs. The keys `1` to `5` and `0` switch tabs; `Esc` shrinks the window to a single line over the prompt, and `ctrl+x` then `tab` hands it the keyboard.

| Tab | Key | What it shows |
| --- | --- | --- |
| Session | `1` | Total cost of this session (including the launches before a resume), cost per active hour, a bar per model, the four token kinds, cache time left and rebuild cost for each conversation, where the money went (main, each subagent, other requests), cost by skill and MCP server, and the best hint |
| Usage | `2` | Session, 24 hours or 30 days, for all agents or one: input by source, output (thinking, replies, writes, commands, agent prompts), cache read by content, cache write by agent and model with the biggest single write and why it happened |
| Context | `3` | What each request carries: system, tools, messages, skills, MCP tools, agents, memory files, with unused and deferred items marked; subagent detail; a transcript view of any agent |
| History | `4` | 30 days: total, token kinds, by day, by model, main versus subagent, subagent type by model, by repository, top sessions with the `claude --resume` command, context fill by tool |
| Hints | `5` | Hints for this session and for the past 24 hours or 30 days: title, amount, summary, action and evidence |
| Help | `0` | Data sources, color legend, keys, settings, version, price source and date, unpriced models |

The foot of the window shows cache timers with the cost to refill them, a context bar with the compact threshold, and your 5-hour and 7-day limits with reset times. Each session gets one toast when a limit goes above 80%.

### Layouts

The window picks a drawing from its width: under 40 columns a compact card, 40 to 69 narrow, 70 and up full. Inline and under 10 rows it draws a short view. Folded, the window leaves one line over the prompt: the best hint and its saving, a character chart of the past 8 hours, cost, context and cache timer, with parts dropped as the terminal narrows. The desktop app adds a low-key summary strip, and in VS Code the window draws without the key bar. A docked window asks for 90 by 40; a terminal under 144 columns starts folded, and under 110 columns the window cannot dock.

### Hints

Every hint states a saving and links to its evidence. The rules:

- `near-limit`, `limit-pace`: you are close to a 5-hour or 7-day limit, or the current pace will use it up before it resets.
- `cache-rebuilt`, `cache-ttl-choice`: caches that expired during pauses and were rewritten, and whether the 5-minute or the 1-hour cache is cheaper for your pauses.
- `subagent-model`, `subagent-overhead`, `main-model-overkill`: work on a larger model than the task needs, many tiny subagent tasks, and long read-only stretches on the main model. A low-confidence suggestion says "try it" and never "downgrade".
- `memory-heavy`, `skill-catalog-heavy`, `mcp-schema-heavy`, `unused-plugin`, `unused-mcp-server`: standing context you pay for on every request.
- `long-session`, `repeat-compaction`: sessions that grow past 70% of the window and sessions compacted three times or more.
- `costly-attribution`: one skill or plugin accounts for over 20% of attributed cost.
- `whole-reads`, `command-output`, `tool-output`, `huge-tool-result`, `big-paste`: the same file read in full three times, commands and tools whose output is re-read on every request, a single giant tool result, a large paste.
- `thinking-output`, `fast-mode`: thinking above 60% of output, and fast mode above 20% of cost.

On the Hints tab, `y` adopts a hint. tally records the rule's metric, the expected saving and the date. After `recheckDays` it reminds you and shows expected against actual saving, for the rules that have a before-and-after metric.

### Multiple machines

With `syncDir` set, each machine writes its totals to `<syncDir>/tally/<machineName>.json` and reads the others. History and Hints then get a `t` key that switches between this computer and all computers. Blocks that cannot be merged say "This computer only" in the all-computers view. See [Privacy](#privacy) for what each `shareDetail` level shares.

### Report and Herdr

`/tally report [days] [repo]` writes a markdown spend report to `api-spend-<date>.md` in the folder Claude Code is working in, which you can read or hand to someone. A report from the same day overwrites the earlier file, and it lists repository names. Claude can call the same report through the `tally_report` tool, and the bundled `spend-optimize` skill walks through it, applies the changes you choose, and stores a baseline for a comparison 14 days on. With `herdrSidebar` on, tally also writes a sidebar for the Herdr app from report snapshots (24 hours and 30 days). Turning it off removes what tally wrote.

## Settings

Set the options through the plugin settings (`userConfig` in `plugin.json`), for example `claude plugin configure tally`. The display settings can also be changed from the prompt in any word order, for example `/tally money dollars`.

| Option | Default | Meaning |
| --- | --- | --- |
| `priceUpdate` | true | Refresh the price table weekly from the Anthropic pricing page. Off keeps the built-in prices and makes no network call. |
| `syncDir` | empty | A folder synced by something you already use. Empty turns sharing off. If it is a git repository, tally pulls and pushes it from the CLI. |
| `machineName` | hostname | How this machine is labelled in shared totals. Set it when you use `syncDir`: it is the file name each machine writes, so a name that changes (a renamed host) would count the same machine twice. |
| `shareDetail` | numbers | `numbers`, `repos` or `full`. See [Privacy](#privacy). |
| `redactEvidence` | false | Redact the evidence in the window the way the report does: commands keep only the program name, titles are blank, paths keep only the file name. |
| `recheckDays` | 14 | Days after you adopt a hint before tally checks whether the saving held. |
| `open` | before-first-message | `before-first-message` opens at session start and folds on your first message; `always` keeps it open; `never` opens it only on `/tally`. |
| `money` | cents-and-dollars | `cents-and-dollars` shows cents under $1 and dollars above; `cents` and `dollars` use one unit throughout. |
| `decimals` | auto | `auto` trims trailing zeros; `0` to `4` fixes the decimals on every amount. |
| `desktopRow` | true | A one-line summary strip over the prompt in the desktop app. |
| `herdrSidebar` | false | Also write the spend report to a Herdr sidebar. |

## Commands

| Command | What it does |
| --- | --- |
| `/tally` | Opens the window, or unfolds it. |
| `/tally <tab>` | Opens on `session`, `usage`, `context`, `history`, `hints` or `help`. |
| `/tally 24h` or `30d` | Opens with that time span. |
| `/tally money dollars` | Sets a display option; also `decimals`, `open`, `row`. Word order is free. |
| `/tally report [days] [repo]` | Writes a markdown spend report to `api-spend-<date>.md` in the working folder. |
| `/tally sync` | Runs one sync now (needs `syncDir`) and lists the machines it saw. |
| `/tally debug` | Shows scan progress and totals; `--json` prints them as JSON. |

## Privacy

What tally reads: the Claude Code transcripts under `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects` (on Windows `%USERPROFILE%\.claude\projects`), the Claude desktop app's local session folders if they exist, and the installed-plugin list for the unused-plugin hint.

What it writes: its own files under `<config>/tally/` (the index, a scan lease, progress and report snapshots); if you set `syncDir`, one totals file there; and, only when you run `/tally report`, `api-spend-<date>.md` in the current working folder (a report from the same day overwrites it, and it lists repository names). tally never writes or edits a transcript.

Network: one request, to `https://platform.claude.com/docs/en/about-claude/pricing.md`, at most once a week. It sends no data about you. Set `priceUpdate` to false and tally makes no request. If `syncDir` is a git repository, tally runs `git pull --rebase`, `commit` and `push` on it from the CLI; that talks to your own remote and nothing else. Failures are logged and never shown as an error.

What sharing sends, by `shareDetail`:

| Level | Shared with your other machines |
| --- | --- |
| `numbers` (default) | Hourly totals: date, model, token counts and cost, main versus subagent. Repositories appear only as irreversible aliases. |
| `repos` | Adds repository names and per-repository totals. |
| `full` | Adds session titles, top sessions, context fill by tool and each machine's hints with evidence. |

Keep any machine whose repository names or titles are private at `numbers`. Repository aliases are an HMAC with a salt stored in `<syncDir>/tally/salt`, created by the first machine, so the same repository has the same alias everywhere. Transcripts stay on the machine that made them, so nothing is counted twice.

## Windows, macOS and Linux

- One code base and one install command on all three. Paths accept both `/` and `\`. The home folder comes from `HOME`, with `USERPROFILE` as the fallback on Windows.
- CI runs `claude plugin validate` and `claude plugin test` on macOS, Windows and Ubuntu for every push.
- Git-based sync needs `git` on PATH and runs only from the CLI. The desktop app and VS Code skip it; the next CLI session pushes.
- The Herdr sidebar folder is `HERDR_APP_HOME` when set, otherwise `~/.config/herdr-app` on macOS and Linux and `%APPDATA%\herdr-app` on Windows. If the folder does not exist, tally writes nothing.

## Performance

Measured on one macOS development machine on 2026-11-27, with 30 days of history: about 8.3 GB in 82,000 transcript files.

| What | Result |
| --- | --- |
| Cold scan, from nothing to done | 84 to 89 s (target: 120 s or less) |
| Warm start, index already on disk | about 5 s, up to about 13 s under heavy machine load, with no transcript bytes read |
| Incremental update after a few files change | under 5 s |
| Index size on disk after the cold scan | 96.7 MB, about 1.2% of the transcript size |
| CPU per scan slice | about 50 ms, then yield |

The full method is in [docs/en/DESIGN.md](./docs/en/DESIGN.md). Typing latency during a scan has not been measured by hand yet.

Accuracy was checked against ccusage over the same 30 local days on that machine: over the 30 local days from 2026-10-30 to 2026-11-28, tally was within 0.010% of ccusage on the total and within 0.03% on each model. The figures, method and known definitional differences are in [scripts/compare.md](./scripts/compare.md).

## Limitations

- Claude Code only. Codex, Cursor and other agents are not read.
- Dollar amounts are API-equivalent: what the same usage would cost at list prices. They are not your subscription bill.
- Batch and data-residency pricing are not covered, because transcripts carry no signal for them.
- A context breakdown is only available for the running main session. For history, tally keeps a snapshot per live session and uses the nearest one as a stand-in, marked with `*`.
- There is no per-subagent context breakdown.
- Models that are not Anthropic's are listed as unpriced. Unknown Claude models use the latest price of their family and are marked `*`.
- The first scan of a very large history takes a minute or more; the window shows partial numbers until it finishes.
- Windows is covered by CI; manual testing on a real Windows machine is pending.

## Contributing

Bug reports, wrong numbers and hints that fired at the wrong moment are the most useful things to send. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md). Security reports go through [SECURITY.md](./SECURITY.md).

```bash
claude plugin validate .
claude plugin test .
```

## License

Dual-licensed under [MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at your option.
