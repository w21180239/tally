---
name: spend-optimize
description: Use when the user wants to cut Claude Code spend, find where the API-equivalent dollars go, act on tally's saving hints, or produce an API spend report file.
---

# Spend optimize

Turn tally's own numbers into a short report, a few agreed changes, and a baseline to measure them against later.

Work only with the `mcp__tally__tally_report` tool, WebFetch, AskUserQuestion, Read, Edit, Write and plain reasoning. Run no scripts and no bun, node or other programs: every figure comes from the tool.

The tool needs the tally plugin loaded. If it is missing from the tool list, say so and stop.

## Steps

### 1. Fetch the 30-day report

Call `mcp__tally__tally_report` with `{ "days": 30 }`. The answer is markdown with five sections: Summary, Tables, Drivers (the ranked hints), Baseline comparison, Confidence.

Each hint in Drivers carries a `Rule:` line with its rule id. Keep these ids; step 8 needs them.

If Confidence says projects are not indexed yet, or a model has no price, tell the user the figures are low and offer to rerun once the scan finishes. Continue only if they agree.

### 2. Check the price table

The Confidence section has a `Price table:` line, either `built-in (<date>)` or `fetched <date> from <page>`. It states the same source and date as the Prices line on tally's Help tab.

WebFetch `https://platform.claude.com/docs/en/about-claude/pricing.md` and compare:

- Per-million-token rates of the models that carry most of the spend (the By model table).
- Any model in the By model table that the page lists and tally priced at $0.

Note the outcome in one line: matching, or which model differs and by how much. A mismatch does not stop the run; it goes into the file and into your reading of the numbers. If the fetch fails, say so and carry on.

### 3. Fetch the report with the baseline comparison

Call the tool again with `{ "days": 30, "compare": true }`. When a baseline exists, its Baseline comparison section shows the pace then and now and which hints were flagged at that time. With none saved the section says so; that is expected on a first run.

### 4. Write the file

Write `api-spend-<YYYY-MM-DD>.md` in the current working folder, using today's local date. Contents: the full markdown from step 3, then a short `## Price check` section with the step 2 outcome. Do not alter figures. Name the path afterwards.

### 5. Interpret

Tell the user, in plain words and briefly:

- What the 30 days cost in total, and the split between main thread and sub-agents, models and repositories.
- The one to three drivers that matter most, with the reason each costs what it does.
- How far to trust it: the Confidence level, low-confidence and projected hints, thin data.
- Whether the pace moved against the baseline, if one was compared.

Hint dollar figures are estimates that overlap, so never add them into one total saving. A hint marked as a what-if shows a projected saving, not billed spend. Amounts are API list prices, not an invoice.

### 6. Choose what to adopt

If the report flagged nothing, say so and go to step 8 without an adopt list.

Otherwise call AskUserQuestion with `multiSelect: true`. Offer the hints in the report's order, at most four options per question and at most four questions; leave out the rest and name them in your reading. One option per hint: the label is the hint title, the description its dollar figure and a one-line summary of its action. Include a hint with no dollar figure if it is useful. The user may pick none.

### 7. Apply the changes

For each chosen hint, make the change its `Action:` line describes: read the current file, edit it, and show what changed. Typical targets are user or project settings, a `CLAUDE.md`, a skill or hook, an MCP or plugin entry. Rules:

- Touch only what a chosen hint calls for.
- When the action is a habit the user must carry out (a command to run, a way of working), do not fake it; list it as theirs to do.
- When the action is unclear or would change something broader than the hint, ask before editing.

Track which chosen hints you carried out or set up, and which stay with the user.

### 8. Save the baseline and record the adoptions

Call `mcp__tally__tally_report` once with `{ "days": 30, "saveBaseline": true, "adopt": [<rule ids>] }`. `adopt` lists the rule ids of the chosen hints that are done or handed to the user; leave it out when none were chosen. The tool stores the current pace and each hint's expected saving, and records an adoption for each id.

Read the closing lines of the answer. `Baseline saved` confirms the baseline. `Adopted:` names the recorded ids; `Skipped` lines name any id that was unknown or not flagged, so correct a mistyped id and call again.

Finish with a short summary: what changed, what stays with the user, and that tally compares the effect of an adopted hint after `recheckDays` days (14 by default) and reports it as a notice. Only rules with a before-and-after measure are rechecked; the rest are just recorded.
