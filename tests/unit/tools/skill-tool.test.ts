/**
 * Tests for skill-tool.ts — list_skills and invoke_skill agent-callable tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleListSkills,
  handleInvokeSkill,
  createSkillTools,
  LIST_SKILLS_TOOL_DEFINITION,
  LIST_SKILLS_TOOL_NAME,
  INVOKE_SKILL_TOOL_DEFINITION,
  INVOKE_SKILL_TOOL_NAME,
} from '../../../src/tools/skill-tool.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../src/skills/skill-loader.js', () => ({
  loadSkills: vi.fn().mockResolvedValue([
    {
      name: 'sophia-image-generator',
      description: 'Generate Sophia images',
      path: '/mock/sophia/SKILL.md',
    },
    {
      name: 'storybrand-content-engine',
      description: 'Create StoryBrand content',
      path: '/mock/story/SKILL.md',
    },
  ]),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn().mockResolvedValue('# Skill content\n\nHello {{name}}!'),
    mkdir: vi.fn(),
  },
}));

// ─── Tool Definitions ──────────────────────────────────────────────────────────

describe('LIST_SKILLS_TOOL_DEFINITION', () => {
  it('has correct name', () => {
    expect(LIST_SKILLS_TOOL_DEFINITION.name).toBe('list_skills');
  });

  it('has no required fields', () => {
    expect(LIST_SKILLS_TOOL_DEFINITION.input_schema.required).toHaveLength(0);
  });

  it('defines filter as optional string property', () => {
    const props = LIST_SKILLS_TOOL_DEFINITION.input_schema.properties;
    expect(props.filter.type).toBe('string');
  });
});

describe('INVOKE_SKILL_TOOL_DEFINITION', () => {
  it('has correct name', () => {
    expect(INVOKE_SKILL_TOOL_DEFINITION.name).toBe('invoke_skill');
  });

  it('requires name', () => {
    expect(INVOKE_SKILL_TOOL_DEFINITION.input_schema.required).toContain('name');
  });

  it('defines context as optional object', () => {
    const props = INVOKE_SKILL_TOOL_DEFINITION.input_schema.properties;
    expect(props.context.type).toBe('object');
  });
});

// ─── handleListSkills ──────────────────────────────────────────────────────────

describe('handleListSkills', () => {
  it('returns all skills when no filter', async () => {
    const result = await handleListSkills({});
    expect(result.count).toBe(2);
    expect(result.skills[0]!.name).toBe('sophia-image-generator');
    expect(result.skills[1]!.name).toBe('storybrand-content-engine');
  });

  it('filters by name substring (case-insensitive)', async () => {
    const result = await handleListSkills({ filter: 'story' });
    expect(result.count).toBe(1);
    expect(result.skills[0]!.name).toBe('storybrand-content-engine');
  });

  it('returns empty list when filter matches nothing', async () => {
    const result = await handleListSkills({ filter: 'nonexistent' });
    expect(result.count).toBe(0);
    expect(result.skills).toHaveLength(0);
  });

  it('returns skillsDir in result', async () => {
    const result = await handleListSkills({}, '/custom/skills/dir');
    expect(result.skillsDir).toBe('/custom/skills/dir');
  });

  it('includes description in each skill entry', async () => {
    const result = await handleListSkills({});
    expect(result.skills[0]!.description).toBe('Generate Sophia images');
  });
});

// ─── handleInvokeSkill ────────────────────────────────────────────────────────

describe('handleInvokeSkill', () => {
  const allowAll = (_tool: string, _args: Record<string, unknown>) => true;
  const denyAll = (_tool: string, _args: Record<string, unknown>) => false;

  it('returns skill content', async () => {
    const result = await handleInvokeSkill(
      { name: 'sophia-image-generator' },
      allowAll,
    );
    expect(result.skillName).toBe('sophia-image-generator');
    expect(result.content).toContain('Skill content');
    expect(result.path).toBe('/mock/sophia/SKILL.md');
  });

  it('applies template variable substitution', async () => {
    const result = await handleInvokeSkill(
      { name: 'sophia-image-generator', context: { name: 'World' } },
      allowAll,
    );
    expect(result.content).toContain('Hello World!');
    expect(result.content).not.toContain('{{name}}');
  });

  it('handles multiple template substitutions', async () => {
    // Override the mock for this test to include multiple placeholders
    const { loadSkills } = await import('../../../src/skills/skill-loader.js');
    const fs = (await import('node:fs/promises')).default;
    vi.mocked(fs.readFile).mockResolvedValueOnce('{{greeting}} {{target}}!');

    const result = await handleInvokeSkill(
      { name: 'sophia-image-generator', context: { greeting: 'Hello', target: 'World' } },
      allowAll,
    );
    expect(result.content).toBe('Hello World!');
    // restore for next tests
    vi.mocked(fs.readFile).mockResolvedValue('# Skill content\n\nHello {{name}}!');
    void loadSkills; // keep import alive
  });

  it('throws when policy denies', async () => {
    await expect(
      handleInvokeSkill({ name: 'sophia-image-generator' }, denyAll),
    ).rejects.toThrow('Policy denied');
  });

  it('throws when skill not found', async () => {
    await expect(
      handleInvokeSkill({ name: 'nonexistent-skill' }, allowAll),
    ).rejects.toThrow('not found');
  });

  it('includes available skills in not-found error message', async () => {
    await expect(
      handleInvokeSkill({ name: 'nonexistent-skill' }, allowAll),
    ).rejects.toThrow('sophia-image-generator');
  });
});

// ─── createSkillTools ─────────────────────────────────────────────────────────

describe('createSkillTools', () => {
  it('returns two tool definitions', () => {
    const tools = createSkillTools(null);
    expect(tools).toHaveLength(2);
  });

  it('first tool is list_skills', () => {
    const tools = createSkillTools(null);
    expect(tools[0]!.name).toBe(LIST_SKILLS_TOOL_NAME);
  });

  it('second tool is invoke_skill', () => {
    const tools = createSkillTools(null);
    expect(tools[1]!.name).toBe(INVOKE_SKILL_TOOL_NAME);
  });

  it('list_skills handler returns skills list', async () => {
    const tools = createSkillTools(null);
    const listTool = tools[0]!;
    const result = await listTool.handler({}) as { count: number };
    expect(result.count).toBe(2);
  });

  it('invoke_skill handler returns skill content when policyEngine is null', async () => {
    const tools = createSkillTools(null);
    const invokeTool = tools[1]!;
    const result = await invokeTool.handler({ name: 'sophia-image-generator' }) as { skillName: string; content: string };
    expect(result.skillName).toBe('sophia-image-generator');
    expect(result.content).toContain('Skill content');
  });

  it('invoke_skill handler accepts context for substitution', async () => {
    const tools = createSkillTools(null);
    const invokeTool = tools[1]!;
    const result = await invokeTool.handler({
      name: 'sophia-image-generator',
      context: { name: 'Claude' },
    }) as { content: string };
    expect(result.content).toContain('Hello Claude!');
  });

  it('works with a mock PolicyEngine that allows', async () => {
    const mockEngine = {
      validatePath: vi.fn().mockReturnValue({ allowed: true }),
    } as unknown as import('../../../src/security/policy-engine.js').PolicyEngine;

    const tools = createSkillTools(mockEngine);
    const invokeTool = tools[1]!;
    const result = await invokeTool.handler({ name: 'sophia-image-generator' }) as { skillName: string };
    expect(result.skillName).toBe('sophia-image-generator');
    expect(mockEngine.validatePath).toHaveBeenCalled();
  });

  it('throws when PolicyEngine denies the skills directory', async () => {
    const mockEngine = {
      validatePath: vi.fn().mockReturnValue({ allowed: false, reason: 'path denied' }),
    } as unknown as import('../../../src/security/policy-engine.js').PolicyEngine;

    const tools = createSkillTools(mockEngine);
    const invokeTool = tools[1]!;
    await expect(
      invokeTool.handler({ name: 'sophia-image-generator' }),
    ).rejects.toThrow('Policy denied');
  });
});
