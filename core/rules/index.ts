// The baseline hint rules, one file each. List order does not matter: results are sorted by amount.
import type { HintRule } from "../hint.ts";
import { bigPaste } from "./big-paste.ts";
import { cacheRebuilt } from "./cache-rebuilt.ts";
import { commandOutput } from "./command-output.ts";
import { costlyAttribution } from "./costly-attribution.ts";
import { fastMode } from "./fast-mode.ts";
import { longSession } from "./long-session.ts";
import { nearLimit } from "./near-limit.ts";
import { repeatCompaction } from "./repeat-compaction.ts";
import { subagentModel } from "./subagent-model.ts";
import { thinkingOutput } from "./thinking-output.ts";
import { toolOutput } from "./tool-output.ts";
import { unusedMcpServer } from "./unused-mcp-server.ts";
import { unusedPlugin } from "./unused-plugin.ts";
import { wholeReads } from "./whole-reads.ts";

export const BASELINE_RULES: HintRule[] = [nearLimit, cacheRebuilt, subagentModel, unusedPlugin, longSession, costlyAttribution, wholeReads, commandOutput, toolOutput, thinkingOutput, fastMode, repeatCompaction, bigPaste, unusedMcpServer];
