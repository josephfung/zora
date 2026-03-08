/**
 * SubagentTool — delegate_to_subagent custom tool.
 *
 * Loads subagent definitions from .zora/subagents/<name>/SUBAGENT.md
 * and exposes a delegate_to_subagent tool for the LLM to use.
 */

import { loadSubagents } from '../skills/subagent-loader.js';
import type { CustomToolDefinition } from '../orchestrator/execution-loop.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('subagent-tool');

export function createSubagentTools(
  submitTask: (opts: { prompt: string }) => Promise<string>,
): CustomToolDefinition[] {
  const listSubagentsTool: CustomToolDefinition = {
    name: 'list_subagents',
    description: 'List available subagents that can be delegated tasks. Each subagent has a specific role and restricted tool access.',
    input_schema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const subagents = await loadSubagents();
      if (subagents.length === 0) {
        return { subagents: [], message: 'No subagents defined. Create .zora/subagents/<name>/SUBAGENT.md to define one.' };
      }
      return {
        subagents: subagents.map(s => ({
          name: s.name,
          description: s.description,
          layer: s.layer,
          allowedTools: s.allowedTools,
        })),
        count: subagents.length,
      };
    },
  };

  const delegateToSubagentTool: CustomToolDefinition = {
    name: 'delegate_to_subagent',
    description: 'Delegate a self-contained task to a named subagent. The subagent runs with its declared system prompt and restricted tool subset. Cannot spawn further subagents. Use list_subagents to see available subagents.',
    input_schema: {
      type: 'object',
      properties: {
        subagent_name: {
          type: 'string',
          description: 'Name of the subagent (matches the directory name in .zora/subagents/<name>/)',
        },
        task: {
          type: 'string',
          description: 'The specific task to delegate. Be precise — the subagent has no conversation history.',
        },
      },
      required: ['subagent_name', 'task'],
    },
    handler: async (input: Record<string, unknown>) => {
      const name = input['subagent_name'] as string;
      const task = input['task'] as string;

      if (!name || !task) {
        return { error: 'subagent_name and task are required' };
      }

      const subagents = await loadSubagents();
      const subagent = subagents.find(s => s.name === name);

      if (!subagent) {
        const available = subagents.map(s => s.name);
        return {
          error: `Subagent '${name}' not found.`,
          available: available.length > 0 ? available : 'none defined',
        };
      }

      log.info({ subagent: name, taskLength: task.length }, 'Delegating to subagent');

      try {
        // NOTE: SubmitTaskOptions does not yet support systemPrompt override.
        // As a workaround, we prepend the subagent's system prompt as context
        // in the task prompt. Full systemPrompt threading is tracked as a
        // follow-up (requires SubmitTaskOptions.systemPrompt field).
        const augmentedPrompt = subagent.systemPrompt
          ? `[Subagent context — follow these instructions throughout this task]\n${subagent.systemPrompt}\n\n[Task]\n${task}`
          : task;

        const result = await submitTask({ prompt: augmentedPrompt });
        return { result, subagent: name };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ subagent: name, err: msg }, 'Subagent delegation failed');
        return { error: `Subagent '${name}' failed: ${msg}` };
      }
    },
  };

  return [listSubagentsTool, delegateToSubagentTool];
}
