---
name: spend-optimize
description: Use when the user wants to cut Claude Code spend, see what it costs at API rates and where that goes, act on tally's saving hints, or produce an API spend report file.
---

# Spend optimize

A guided pass over tally's numbers: read the spend, agree a few changes with the user, make them, and store a reference point so the effect can be seen later.

## Ground rules

- Tools allowed: `mcp__tally__tally_report`, WebFetch, AskUserQuestion, Read, Edit, Write. No scripts, no bun or node, no other programs. The dollar amounts you quote are the ones the report prints.
- Any of those tools may be deferred and absent from your tool list. Load the missing ones in one ToolSearch call, for example query `select:mcp__tally__tally_report,WebFetch,AskUserQuestion`. If ToolSearch cannot find `tally_report`, tally is not loaded: tell the user and stop. If WebFetch cannot be loaded, skip the price comparison, say that in the file and in your reading, and move on. Do not hand the fetch to another agent.

## 1. Pull the 30-day report

Call `mcp__tally__tally_report` with `{ "days": 30 }`. The answer is markdown: Summary, Tables, Drivers (the ranked hints), Baseline comparison, Confidence.

Each hint under Drivers has a `Rule:` line holding its rule id. Note the ids for step 8.

Read Confidence before anything else. A line about projects that are not indexed yet, or about a model that was priced at $0, means the totals undercount. Tell the user, and ask whether to wait for the scan and rerun or to carry on. Remember the answer: it decides step 8.

## 2. Compare prices with the official page

Confidence ends with a `Price table:` line: `built-in (<date>)`, or `fetched <date> from <page>`. That is the same source and date the Help tab shows under Prices.

Open `https://platform.claude.com/docs/en/about-claude/pricing.md` through WebFetch. Look at the models that carry most of the spend in the By model table:

- Do the per-million-token rates on the page equal those tally used?
- Is any model the page lists priced at $0 by tally?

Record one line: the rates agree, or which model differs and in which direction. A difference does not stop the run; fold it into the file and into how you read the totals.

## 3. Pull the report again with the comparison

Call the tool with `{ "days": 30, "compare": true }`. With a saved baseline, the Baseline comparison section gives the pace then and now, plus the hints flagged back then. Note the old run rate; step 8 may need it. With no baseline the section says so, which is normal on a first pass.

## 4. Save the markdown file

Create `api-spend-<YYYY-MM-DD>.md` in the working folder, dated today in local time. Put the markdown from step 3 in unchanged, then add a `## Price check` section carrying the step 2 line. Tell the user the path.

## 5. Read it out

Give the user a short reading, plain words:

- The 30-day total, the main-thread versus sub-agent split, and where the models and repositories sit.
- The one to three drivers that matter most, and why each one costs what it does.
- How much weight the numbers can bear, from the Confidence section: its level, low-confidence hints, what-if hints, few active days.
- Movement against the baseline, when step 3 found one.

Hint amounts are estimates that overlap; never total them. A what-if hint shows a projected saving rather than billed spend. Every amount is an API list price, not an invoice.

## 6. Let the user pick

AskUserQuestion needs at least two options per question and at most four, and allows at most four questions. Build the choices from the hints in report order, one option per hint: label is the hint title, description is its amount and a one-line version of its action. Use `multiSelect: true`.

- Zero hints flagged: say so, skip steps 6 and 7, and go to step 8 with no adopt list.
- Exactly one hint: add a second option labelled "None", so the question is valid and the user can decline.
- More than four hints: ask in groups of four, in order, up to four questions; name the leftover hints in your reading.

A hint that carries no dollar figure may still be offered. Choosing nothing is a valid outcome.

## 7. Make the changes

For each chosen hint, do what its `Action:` line says: read the file it concerns, edit it, and show the user the change. Likely places are user or project settings, a `CLAUDE.md`, a hook, or an MCP or plugin entry.

- Edit only what a chosen hint requires.
- When the action is something the user has to do themselves, for example running something or changing a working habit, hand it to them as a to-do instead of pretending it is done.
- When the action is vague or would reach beyond the hint, ask first.

Keep two lists: hints you completed or set up, and hints left with the user. Both go to step 8.

## 8. Store the reference point and the adoptions

A baseline overwrites the previous one, so decide whether to store one:

- If step 1 showed unindexed projects or priced-at-$0 models, the current pace is partial and would replace a good baseline with a low one. Leave `saveBaseline` out, or ask the user first and save only if they agree.
- Otherwise include `"saveBaseline": true`.

Call `mcp__tally__tally_report` once with `{ "days": 30, "saveBaseline": true, "adopt": [<rule ids>] }`, dropping `saveBaseline` when step 8 says so and dropping `adopt` when nothing was chosen. `adopt` takes the ids of both lists from step 7. With neither field the call is pointless; skip it.

Check the closing lines of the answer. `Baseline saved: $<rate> per 30 days` confirms the new baseline. `Adopted:` lists the recorded ids; each `Skipped` line names an id that was unknown or not flagged, so fix a mistyped one and call again.

Close with a summary for the user:

- What was changed, and what is still theirs to do.
- Whether a baseline was stored. If it replaced an earlier one, give the old run rate from step 3 next to the new one. If you did not store one, say why.
- That tally revisits each adopted hint after `recheckDays` days (14 by default) and shows the expected versus actual saving as a notice. Hints without a before-and-after measure are recorded only.
