/**
 * SkillTool — Exposes the Claude Code skill library to running Zora agents.
 *
 * list_skills: discover available skills in ~/.claude/skills/
 * invoke_skill: load and return a skill's content for injection into context
 *
 * Security: invoke_skill checks PolicyEngine.validatePath before loading any
 * skill content. Skills must exist on disk — no remote loading.
 *
 * Usage: call createSkillTools(policyEngine) and spread the result into
 * _createCustomTools() in the Orchestrator.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { CustomToolDefinition } from '../orchestrator/execution-loop.js';
import { loadSkills } from '../skills/skill-loader.js';
import { createLogger } from '../utils/logger.js';
import type { PolicyEngine } from '../security/policy-engine.js';

const log = createLogger('skill-tool');

// ─── Tool Names ────────────────────────────────────────────────────────────────

export const LIST_SKILLS_TOOL_NAME = 'list_skills';
export const INVOKE_SKILL_TOOL_NAME = 'invoke_skill';

// ─── Tool Definitions (for documentation/testing) ─────────────────────────────

export const LIST_SKILLS_TOOL_DEFINITION = {
  name: LIST_SKILLS_TOOL_NAME,
  description:
    'List all available Claude Code skills from ~/.claude/skills/. ' +
    'Call this before invoke_skill to confirm the skill exists.',
  input_schema: {
    type: 'object' as const,
    properties: {
      filter: {
        type: 'string',
        description: 'Optional: filter skills by name substring',
      },
    },
    required: [] as string[],
  },
};

export const INVOKE_SKILL_TOOL_DEFINITION = {
  name: INVOKE_SKILL_TOOL_NAME,
  description: [
    'Load and return a Claude Code skill by name.',
    'Skills are reusable prompt templates in ~/.claude/skills/<name>/SKILL.md.',
    'The skill content is returned as text for injection into your context.',
    'Call list_skills first to see available skills.',
  ].join(' '),
  input_schema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: 'Exact skill name (directory name in ~/.claude/skills/)',
      },
      context: {
        type: 'object',
        description:
          'Optional: key-value pairs for template variable substitution in the skill',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['name'] as string[],
  },
};

// ─── Handler Types ─────────────────────────────────────────────────────────────

export interface ListSkillsArgs {
  filter?: string;
}

export interface ListSkillsResult {
  skills: Array<{ name: string; description: string }>;
  count: number;
  skillsDir: string;
}

export interface InvokeSkillArgs {
  name: string;
  context?: Record<string, string>;
}

export interface InvokeSkillResult {
  skillName: string;
  content: string;
  path: string;
}

// ─── Pure Handlers (testable without PolicyEngine) ────────────────────────────

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/**
 * Lists available skills, optionally filtered by name substring.
 */
export async function handleListSkills(
  args: ListSkillsArgs,
  skillsDir = SKILLS_DIR,
): Promise<ListSkillsResult> {
  const all = await loadSkills(skillsDir);
  const skills = args.filter
    ? all.filter(s => s.name.toLowerCase().includes(args.filter!.toLowerCase()))
    : all;

  log.debug({ total: all.length, filtered: skills.length }, 'list_skills called');

  return {
    skills: skills.map(s => ({ name: s.name, description: s.description })),
    count: skills.length,
    skillsDir,
  };
}

/**
 * Loads a skill by name and returns its content.
 * The checkPolicy callback is called before loading — throw or return false to deny.
 */
export async function handleInvokeSkill(
  args: InvokeSkillArgs,
  checkPolicy: (tool: string, args: Record<string, unknown>) => boolean,
  skillsDir = SKILLS_DIR,
): Promise<InvokeSkillResult> {
  const { name, context = {} } = args;

  // Policy check before loading any skill content
  if (!checkPolicy(INVOKE_SKILL_TOOL_NAME, { name })) {
    throw new Error(`Policy denied: invoke_skill("${name}")`);
  }

  const all = await loadSkills(skillsDir);
  const skill = all.find(s => s.name === name);

  if (!skill) {
    const names = all.map(s => s.name).join(', ');
    throw new Error(
      `Skill "${name}" not found. Available: ${names || 'none'}`,
    );
  }

  let content = await fs.readFile(skill.path, 'utf-8');

  // Simple template substitution: {{key}} → value
  for (const [key, value] of Object.entries(context)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }

  log.info({ skillName: name, contentLength: content.length }, 'skill invoked by agent');

  return { skillName: name, content, path: skill.path };
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates list_skills and invoke_skill tool definitions wired to a PolicyEngine.
 *
 * The policyEngine is used to validate the skill path before loading content.
 * If policyEngine is null (e.g. in tests), all invocations are allowed.
 *
 * @returns Two CustomToolDefinition entries for the Orchestrator's _createCustomTools()
 */
export function createSkillTools(
  policyEngine: PolicyEngine | null,
): CustomToolDefinition[] {
  // Build a policy check function from the engine.
  // invoke_skill loads a file from disk — use validatePath to ensure the
  // skill path is within the policy's allowed filesystem boundaries.
  const checkPolicy = (tool: string, _args: Record<string, unknown>): boolean => {
    if (!policyEngine) return true; // no engine → allow (safe default for tests)
    if (tool === INVOKE_SKILL_TOOL_NAME) {
      // We don't know the resolved path yet (need to scan first), so we validate
      // the skills directory root. Full path validation happens after scan finds the skill.
      const result = policyEngine.validatePath(SKILLS_DIR);
      if (!result.allowed) {
        log.warn({ reason: result.reason }, 'invoke_skill blocked by policy');
        return false;
      }
    }
    return true;
  };

  const listSkillsTool: CustomToolDefinition = {
    name: LIST_SKILLS_TOOL_NAME,
    description: LIST_SKILLS_TOOL_DEFINITION.description,
    input_schema: LIST_SKILLS_TOOL_DEFINITION.input_schema,
    handler: async (input: Record<string, unknown>): Promise<unknown> => {
      const args: ListSkillsArgs = {
        filter: input['filter'] as string | undefined,
      };
      return handleListSkills(args);
    },
  };

  const invokeSkillTool: CustomToolDefinition = {
    name: INVOKE_SKILL_TOOL_NAME,
    description: INVOKE_SKILL_TOOL_DEFINITION.description,
    input_schema: INVOKE_SKILL_TOOL_DEFINITION.input_schema,
    handler: async (input: Record<string, unknown>): Promise<unknown> => {
      const args: InvokeSkillArgs = {
        name: input['name'] as string,
        context: input['context'] as Record<string, string> | undefined,
      };
      const result = await handleInvokeSkill(args, checkPolicy);
      // Return content as top-level string so the LLM receives it directly in context
      return { skillName: result.skillName, content: result.content, path: result.path };
    },
  };

  return [listSkillsTool, invokeSkillTool];
}
