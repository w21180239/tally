# AGENTS.md

How a coding agent works in this repository. Humans can read it too.

## Layout

- `.claude-plugin/plugin.json` (manifest, version, `userConfig`) and `.claude-plugin/marketplace.json` (one plugin, `tally`, sourced from `./`).
- `hooks/hooks.json` loads `hooks/register.tsx`, the only file that calls `on(...)`.
- `core/`: pure functions, no `$`. `engine/`: adapters over `$` (filesystem, clock, store, network). `view/`: UI. `report/`, `herdr/`, `skills/`: report generation, Herdr sidebar resources, the `spend-optimize` skill.
- `tests/`: `*.test.ts` and `*.test.tsx`, with synthetic fixtures under `tests/fixtures/`.
- `docs/en/DESIGN.md`: the design. Read it before changing the scanner, the index format, the lease or the pricing update.
- `scripts/compare.md`: how to cross-check totals against ccusage.
- `repo-assets/`: logo, flow diagram, social preview.

## Commands

Needs the `claude` CLI, 2.1.326 or later.

```sh
claude plugin validate .
claude plugin test .
```

CI runs both on macOS, Windows and Ubuntu (`.github/workflows/test.yml`). Run them before every commit that touches code or the manifest.

## Rules

- **Zero runtime dependencies.** No npm packages, no Node, Bun or Python, no external binaries. The one exception is `git` for sync, run through `$.process.run`, CLI only, failures logged and never shown.
- **`core/` never touches `$`.** Any `$` use belongs in `engine/` or `view/`.
- **Engine quirks.**
  - A module fails to load if `$.<noun>` is used as a value (`const fs = $.fs`, passing `$.clock` around). Call members directly (`$.fs.read(...)`), and pass `$` itself or an arrow function when a helper needs one.
  - `$.env.get(name)` is async and takes only a string literal name. Read each variable with its own literal call.
  - `$.fs.read` returns at most 4 MiB per call, with byte offsets; a text range that cuts a character gives U+FFFD at that edge. `$.fs.write` is limited to 4 MiB, is not atomic, and has no rename, append or delete.
  - An event hook that loops without awaiting crashes the worker. Run long work in slices of about 50 ms of CPU and yield (`$.clock.sleep(0)`) between them.
  - `$.process` exists only in the CLI.
- **Engine tests use `clockOf` (`tests/world.ts`), not `mock.clock`.** The kit's clock holds `$.clock.sleep(0)` until the test advances it, so the slicer's yield after 50 ms of CPU stalls a hook for the kit's 10 s budget whenever a loaded machine pauses the process. `clockOf` answers a zero wait at once. To check a new test, set the slicer's default budget to `-1` locally (every tick yields) and run the suite.
- **Windows is a first-class platform.** Paths go through `core/path.ts` and accept `/` and `\`. Home is `HOME`, with `USERPROFILE` as the fallback. A change to shared scripts must work on Windows.
- **Privacy.** tally writes no transcript. The only network request is the pricing page (`https://platform.claude.com/docs/en/about-claude/pricing.md`). No repository name, title, path or command leaves the machine unless `shareDetail` is raised. A change that breaks this needs a README and SECURITY.md update in the same pull request.
- **Clean-room.** tally was written from observed behavior of other tools. Never copy code, text or tests from closed-source software. Ideas and formulas are fine; the wording is yours.
- **Synthetic data only.** Fixtures, examples, screenshots and docs contain no real repository names, paths, session titles or amounts from a real machine.
- **English for code, comments, commit messages and PR text.** Comments are terse: the why, not a restatement of the code. UI text is English.
- **Tests with behavior changes.** Add or update a test for every change in behavior. For a bug fix, flip the assertion once and confirm the test fails, then restore it.
- **Docs stay in sync.** The settings table, the key list and the hint list appear in `README.md`, `README.zh-cn.md` and `docs/`. Change them together, and keep the Chinese files faithful to the English ones.
- **Versioning.** Bump `version` in `.claude-plugin/plugin.json` for a release and add a heading to `CHANGELOG.md`. Raise `INDEX_FORMAT` in `core/shard.ts` whenever the parser records a field that existing transcripts would lack.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`). One topic per commit.
