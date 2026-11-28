# Contributing

The most useful things you can send are bug reports with `/tally debug` output, numbers that disagree with another tool, and hints that fired at the wrong moment or gave advice that did not fit. Open an issue with your Claude Code version, your operating system and what you saw. Remove private text first: repository names, session titles, paths and commands.

## Pull requests

1. Fork, branch from `main`, keep the change to one topic.
2. Run the same checks CI runs (needs the `claude` CLI, 2.1.326 or later):

   ```sh
   claude plugin validate .
   claude plugin test .
   ```

   `claude plugin test` starts every test file at once and has no way to cap that. On a heavily loaded machine (a laptop under a build, a small CI runner) an engine-driven test can still time out; a green re-run is the check, and a test that fails twice in a row is a real failure.
3. Add or update a test for any behavior change. For a bug fix, flip the assertion once and confirm the test fails before you commit.
4. Note user-visible changes under a new heading in `CHANGELOG.md`.
5. If you change a setting, a key or a hint, update `README.md`, `README.zh-cn.md` and the pages under `docs/` in the same pull request. If you cannot write Chinese, say so in the pull request and the maintainer will translate.

The maintainer reviews and merges. CI on pull requests from new contributors starts after approval.

## Scope

- Claude Code only. Support for other agents is out of scope for v1.
- No runtime dependencies. No network requests besides the pricing page.
- `core/` stays pure (no `$`); `engine/` holds the adapters. See [AGENTS.md](./AGENTS.md) for the engine quirks and [docs/en/DESIGN.md](./docs/en/DESIGN.md) for the design.
- Windows, macOS and Linux all work. Test paths and separators on both styles.
- Code, comments and identifiers are English.
- Clean-room: ideas from other tools are welcome, copied code, text or tests from closed-source software is not.
- Fixtures, examples and screenshots use synthetic data only.

## License

Contributions are dual-licensed under MIT and Apache-2.0, the same as the project.
