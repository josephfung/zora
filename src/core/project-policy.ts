/**
 * ProjectPolicy — per-project security policy scoped to individual subagents.
 *
 * Policy resolution order:
 *   1. Global policy (~/.zora/policy.toml) — always the ceiling
 *   2. Project policy (.zora/security-policy.toml in project dir)
 *   3. Child inherits parent, can only restrict further
 *
 * Cascade rules:
 *   - Parent's denied list is inherited — child cannot remove denials
 *   - Parent's maxIrreversibilityScore is a ceiling — child cannot raise it
 *   - Child can add to denied list or lower the ceiling
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('project-policy');

export interface ProjectSecurityPolicy {
  tools: {
    allowed?: string[];  // if set, only these tools are allowed (must not be in parent denied)
    denied: string[];    // merged with parent denied (additive)
  };
  filesystem: {
    allowedPaths: string[];
    deniedPaths: string[];
  };
  network: {
    allowedDomains: string[];
  };
  actions: {
    maxIrreversibilityScore: number;  // ceiling — cannot exceed parent's value
  };
}

/** Default permissive policy — no extra restrictions */
const DEFAULT_PROJECT_POLICY: ProjectSecurityPolicy = {
  tools: { denied: [] },
  filesystem: { allowedPaths: [], deniedPaths: [] },
  network: { allowedDomains: [] },
  actions: { maxIrreversibilityScore: 100 },
};

/**
 * Load a project's security-policy.toml.
 * Returns default (permissive) policy if the file doesn't exist.
 */
export async function loadProjectPolicy(projectDir: string): Promise<ProjectSecurityPolicy> {
  const policyPath = path.join(projectDir, '.zora', 'security-policy.toml');

  if (!fs.existsSync(policyPath)) {
    return { ...DEFAULT_PROJECT_POLICY, tools: { denied: [] }, filesystem: { allowedPaths: [], deniedPaths: [] }, network: { allowedDomains: [] }, actions: { maxIrreversibilityScore: 100 } };
  }

  try {
    const { parse: parseTOML } = await import('smol-toml');
    const raw = parseTOML(fs.readFileSync(policyPath, 'utf-8')) as Record<string, unknown>;
    return parseProjectPolicy(raw);
  } catch (err) {
    log.warn({ projectDir, err }, 'Failed to parse security-policy.toml — using defaults');
    return { ...DEFAULT_PROJECT_POLICY, tools: { denied: [] }, filesystem: { allowedPaths: [], deniedPaths: [] }, network: { allowedDomains: [] }, actions: { maxIrreversibilityScore: 100 } };
  }
}

function asStringArray(val: unknown): string[] {
  return Array.isArray(val) && val.every(v => typeof v === 'string') ? (val as string[]) : [];
}

function asScoreBounded(val: unknown): number {
  const n = typeof val === 'number' ? val : 100;
  return Math.max(0, Math.min(100, n));
}

/** Parse raw TOML into a ProjectSecurityPolicy */
export function parseProjectPolicy(raw: Record<string, unknown>): ProjectSecurityPolicy {
  const polRaw = raw['policy'] as Record<string, unknown> | undefined;
  const toolsRaw = (polRaw?.['tools'] ?? raw['tools']) as Record<string, unknown> | undefined;
  const fsRaw = (polRaw?.['filesystem'] ?? raw['filesystem']) as Record<string, unknown> | undefined;
  const netRaw = (polRaw?.['network'] ?? raw['network']) as Record<string, unknown> | undefined;
  const actRaw = (polRaw?.['actions'] ?? raw['actions']) as Record<string, unknown> | undefined;

  const allowedRaw = toolsRaw?.['allowed'];
  return {
    tools: {
      allowed: allowedRaw !== undefined ? asStringArray(allowedRaw) : undefined,
      denied: asStringArray(toolsRaw?.['denied']),
    },
    filesystem: {
      allowedPaths: asStringArray(fsRaw?.['allowed_paths']),
      deniedPaths: asStringArray(fsRaw?.['denied_paths']),
    },
    network: {
      allowedDomains: asStringArray(netRaw?.['allowed_domains']),
    },
    actions: {
      maxIrreversibilityScore: asScoreBounded(actRaw?.['max_irreversibility_score']),
    },
  };
}

/**
 * Merge parent and child policies. Parent is always the ceiling.
 * - denied lists are UNION (most restrictive)
 * - maxIrreversibilityScore is MIN (most restrictive)
 * - allowed list from child is filtered by parent's denied list
 */
export function mergeParentChild(
  parent: ProjectSecurityPolicy,
  child: ProjectSecurityPolicy,
): ProjectSecurityPolicy {
  const mergedDenied = [...new Set([...parent.tools.denied, ...child.tools.denied])];
  // Child can only narrow the parent's allowlist, not widen it.
  // If parent has an explicit allowlist, intersect with child's (if provided).
  // If parent has no allowlist (permissive), child's list is authoritative.
  const childAllowed = child.tools.allowed
    ? (parent.tools.allowed
        ? parent.tools.allowed.filter(t => child.tools.allowed!.includes(t) && !mergedDenied.includes(t))
        : child.tools.allowed.filter(t => !mergedDenied.includes(t)))
    : parent.tools.allowed?.filter(t => !mergedDenied.includes(t));

  return {
    tools: {
      allowed: childAllowed,
      denied: mergedDenied,
    },
    filesystem: {
      // Child can only restrict to a subset of parent's allowed paths — not widen.
      // If parent has no allowedPaths (permissive), child's list is authoritative.
      allowedPaths: parent.filesystem.allowedPaths.length > 0 && child.filesystem.allowedPaths.length > 0
        ? child.filesystem.allowedPaths.filter(cp =>
            parent.filesystem.allowedPaths.some(pp => cp === pp || cp.startsWith(pp + '/'))
          )
        : child.filesystem.allowedPaths.length > 0
          ? child.filesystem.allowedPaths
          : parent.filesystem.allowedPaths,
      deniedPaths: [...new Set([...parent.filesystem.deniedPaths, ...child.filesystem.deniedPaths])],
    },
    network: {
      // Same restriction logic for network domains.
      allowedDomains: parent.network.allowedDomains.length > 0 && child.network.allowedDomains.length > 0
        ? child.network.allowedDomains.filter(cd => parent.network.allowedDomains.includes(cd))
        : child.network.allowedDomains.length > 0
          ? child.network.allowedDomains
          : parent.network.allowedDomains,
    },
    actions: {
      maxIrreversibilityScore: Math.min(
        parent.actions.maxIrreversibilityScore,
        child.actions.maxIrreversibilityScore,
      ),
    },
  };
}

/**
 * Check if a tool is permitted by a project policy.
 * Returns { allowed: boolean, reason?: string }
 */
export function checkToolPermission(
  tool: string,
  policy: ProjectSecurityPolicy,
): { allowed: boolean; reason?: string } {
  if (policy.tools.denied.includes(tool)) {
    return { allowed: false, reason: `Tool "${tool}" is denied by project security policy` };
  }
  if (policy.tools.allowed && policy.tools.allowed.length > 0 && !policy.tools.allowed.includes(tool)) {
    return { allowed: false, reason: `Tool "${tool}" is not in the project's allowed tool list` };
  }
  return { allowed: true };
}

/**
 * Check if an irreversibility score is within the project's limit.
 */
export function checkScoreLimit(
  score: number,
  policy: ProjectSecurityPolicy,
): { allowed: boolean; reason?: string } {
  if (score > policy.actions.maxIrreversibilityScore) {
    return {
      allowed: false,
      reason: `Action irreversibility score ${score} exceeds project policy limit of ${policy.actions.maxIrreversibilityScore}`,
    };
  }
  return { allowed: true };
}

// Registry of active project policies (agentId → policy)
const _policyRegistry = new Map<string, ProjectSecurityPolicy>();

export function registerAgentPolicy(agentId: string, policy: ProjectSecurityPolicy): void {
  _policyRegistry.set(agentId, policy);
  log.debug({ agentId, maxScore: policy.actions.maxIrreversibilityScore }, 'Agent policy registered');
}

export function getAgentPolicy(agentId: string): ProjectSecurityPolicy | null {
  return _policyRegistry.get(agentId) ?? null;
}

export function clearAgentPolicy(agentId: string): void {
  _policyRegistry.delete(agentId);
}
