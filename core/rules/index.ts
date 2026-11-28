// The hint rules, one file each. List order does not matter: results are sorted by amount.
import type { HintRule } from "../hint.ts";
import { bigPaste } from "./big-paste.ts";
import { cacheRebuilt } from "./cache-rebuilt.ts";
import { cacheTtlChoice } from "./cache-ttl-choice.ts";
import { commandOutput } from "./command-output.ts";
import { costlyAttribution } from "./costly-attribution.ts";
import { fastMode } from "./fast-mode.ts";
import { effortMax } from "./effort-max.ts";
import { hugeToolResult } from "./huge-tool-result.ts";
import { idleLoop } from "./idle-loop.ts";
import { longPromptTier } from "./long-prompt-tier.ts";
import { midSessionSwitch } from "./mid-session-switch.ts";
import { ineffectiveCompaction } from "./ineffective-compaction.ts";
import { limitPace } from "./limit-pace.ts";
import { longSession } from "./long-session.ts";
import { mainModelOverkill } from "./main-model-overkill.ts";
import { mcpSchemaHeavy } from "./mcp-schema-heavy.ts";
import { memoryHeavy } from "./memory-heavy.ts";
import { nearLimit } from "./near-limit.ts";
import { skillCatalogHeavy } from "./skill-catalog-heavy.ts";
import { subagentModel } from "./subagent-model.ts";
import { subagentOverhead } from "./subagent-overhead.ts";
import { thinkingOutput } from "./thinking-output.ts";
import { toolOutput } from "./tool-output.ts";
import { unusedMcpServer } from "./unused-mcp-server.ts";
import { unusedPlugin } from "./unused-plugin.ts";
import { wholeReads } from "./whole-reads.ts";

export const BASELINE_RULES: HintRule[] = [nearLimit, cacheRebuilt, subagentModel, unusedPlugin, longSession, costlyAttribution, wholeReads, commandOutput, toolOutput, thinkingOutput, fastMode, bigPaste, unusedMcpServer];

/** Rules with no counterpart in the baseline set. */
export const NEW_RULES: HintRule[] = [memoryHeavy, skillCatalogHeavy, mcpSchemaHeavy, hugeToolResult, limitPace, cacheTtlChoice, subagentOverhead, mainModelOverkill, ineffectiveCompaction, midSessionSwitch, effortMax, longPromptTier, idleLoop];

export const ALL_RULES: HintRule[] = [...BASELINE_RULES, ...NEW_RULES];
