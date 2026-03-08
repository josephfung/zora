/**
 * Subagent CLI Commands — List and inspect available subagent definitions.
 *
 * Subagents live at .zora/subagents/<name>/SUBAGENT.md (project-local)
 * or ~/.zora/subagents/<name>/SUBAGENT.md (global).
 *
 * Commands:
 *   zora-agent subagent list          — list all available subagents
 *   zora-agent subagent info <name>   — show full details for a named subagent
 */

import type { Command } from 'commander';
import { loadSubagents } from '../skills/subagent-loader.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('subagent-commands');

export function registerSubagentCommands(program: Command): void {
  const subagent = program
    .command('subagent')
    .description('List and inspect available subagent definitions');

  subagent
    .command('list')
    .description('List all available subagents from .zora/subagents/ and ~/.zora/subagents/')
    .action(async () => {
      const subagents = await loadSubagents();

      if (subagents.length === 0) {
        console.log('No subagents defined.');
        console.log('Create .zora/subagents/<name>/SUBAGENT.md to define a project-local subagent,');
        console.log('or ~/.zora/subagents/<name>/SUBAGENT.md for a global subagent.');
        return;
      }

      console.log(`Found ${subagents.length} subagent(s):\n`);
      const maxNameLen = Math.max(...subagents.map(s => s.name.length));

      for (const s of subagents) {
        const paddedName = s.name.padEnd(maxNameLen + 2);
        const toolCount = s.allowedTools.length;
        const toolLabel = toolCount === 0 ? '(all tools)' : `${toolCount} tool(s)`;
        console.log(`  ${paddedName}${s.description}  [${s.layer}, ${toolLabel}]`);
      }
    });

  subagent
    .command('info')
    .description('Show full details for a specific subagent')
    .argument('<name>', 'Subagent name (directory name in .zora/subagents/<name>/)')
    .action(async (name: string) => {
      const subagents = await loadSubagents();
      const found = subagents.find(s => s.name === name);

      if (!found) {
        log.error({ name }, 'Subagent not found');
        const similar = subagents.filter(s => s.name.includes(name));
        if (similar.length > 0) {
          console.error(`Did you mean one of: ${similar.map(s => s.name).join(', ')}?`);
        } else if (subagents.length > 0) {
          console.error(`Available subagents: ${subagents.map(s => s.name).join(', ')}`);
        } else {
          console.error('No subagents are currently defined.');
        }
        process.exit(1);
        return;
      }

      console.log(`Name:         ${found.name}`);
      console.log(`Description:  ${found.description}`);
      console.log(`Layer:        ${found.layer}`);
      console.log(`Path:         ${found.path}`);

      if (found.allowedTools.length > 0) {
        console.log(`Allowed tools (${found.allowedTools.length}):`);
        for (const tool of found.allowedTools) {
          console.log(`  - ${tool}`);
        }
      } else {
        console.log('Allowed tools: (all tools — no restriction declared)');
      }

      if (found.systemPrompt) {
        const lines = found.systemPrompt.split('\n');
        const preview = lines.slice(0, 8).join('\n').trim();
        const truncated = lines.length > 8 ? `\n  ... (${lines.length - 8} more lines)` : '';
        console.log(`\nSystem prompt preview:\n  ${preview.split('\n').join('\n  ')}${truncated}`);
      }
    });
}
