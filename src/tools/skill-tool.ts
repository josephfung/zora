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
  denied?: boolean;
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
 * If checkPolicy is provided and denies access to the skills directory,
 * returns an empty list with denied: true rather than throwing.
 */
export async function handleListSkills(
  args: ListSkillsArgs,
  skillsDir = SKILLS_DIR,
  checkPolicy?: (path: string) => Promise<boolean>,
): Promise<ListSkillsResult> {
  if (checkPolicy) {
    const allowed = await checkPolicy(skillsDir);
    if (!allowed) {
      return { skills: [], count: 0, skillsDir, denied: true };
    }
  }

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
 * It is called twice: once for the tool gate, and again for the resolved skill path.
 */
export async function handleInvokeSkill(
  args: InvokeSkillArgs,
  checkPolicy: (pathOrTool: string, args?: Record<string, unknown>) => Promise<boolean>,
  skillsDir = SKILLS_DIR,
): Promise<InvokeSkillResult> {
  const { name, context = {} } = args;

  // Policy check before loading any skill content
  if (!(await checkPolicy(INVOKE_SKILL_TOOL_NAME, { name }))) {
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

  // Validate the resolved skill path to prevent symlink traversal outside the skills directory
  const resolvedSkillPath = path.resolve(skill.path);
  const resolvedSkillsDir = path.resolve(skillsDir);
  if (
    !resolvedSkillPath.startsWith(resolvedSkillsDir + path.sep) &&
    resolvedSkillPath !== resolvedSkillsDir
  ) {
    throw new Error(
      `Skill path "${resolvedSkillPath}" is outside the skills directory`,
    );
  }

  // Per-skill policy check on the resolved path
  const pathAllowed = await checkPolicy(resolvedSkillPath);
  if (!pathAllowed) {
    throw new Error(`Access to skill at "${resolvedSkillPath}" denied by policy`);
  }

  let content = await fs.readFile(resolvedSkillPath, 'utf-8');

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
  // The function accepts either a tool name (with optional args) or a resolved
  // filesystem path, and returns a Promise<boolean> in both cases.
  const checkPolicy = async (
    pathOrTool: string,
    _args?: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!policyEngine) return true; // no engine → allow (safe default for tests)
    // For any call, validate the path or skills directory via validatePath.
    // When called with a tool name, we validate the skills directory root.
    // When called with a resolved skill path, we validate that specific path.
    const pathToCheck =
      pathOrTool === INVOKE_SKILL_TOOL_NAME ? SKILLS_DIR : pathOrTool;
    const result = policyEngine.validatePath(pathToCheck);
    if (!result.allowed) {
      log.warn({ path: pathToCheck, reason: result.reason }, 'skill access blocked by policy');
      return false;
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
      return handleListSkills(args, SKILLS_DIR, checkPolicy);
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
      // Return a structured object with skillName, content, and path fields
      return { skillName: result.skillName, content: result.content, path: result.path };
    },
  };

  return [listSkillsTool, invokeSkillTool];
}
