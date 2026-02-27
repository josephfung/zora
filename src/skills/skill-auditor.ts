/**
 * SkillAuditor — Scans all installed skills at session start.
 *
 * Catches skills that were installed manually (git clone, copy-paste, etc.)
 * without going through the secure install flow. Runs as a SessionStart check.
 *
 * Checks all three skill layers:
 *   ~/.claude/skills/         (global — primary store)
 *   .zora/skills/             (project-local)
 *   <package>/skills/         (built-in)
 *
 * If any installed skill has critical findings, logs a warning and optionally
 * blocks session start (configurable via policy.toml).
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { scanSkillDir, formatScanReport, type FindingSeverity, type ScanResult } from './skill-scanner.js';
import { getSkillLayers } from './skill-loader.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditOptions {
  /** Only report findings at or above this severity (default: high) */
  severityThreshold?: FindingSeverity;
  /** Directories to audit. Defaults to all three skill layers. */
  skillsDirs?: string[];
  /** If true, return immediately on first critical finding */
  failFast?: boolean;
}

export interface AuditReport {
  clean: boolean;
  totalSkills: number;
  flaggedSkills: ScanResult[];
  summary: string;
}

// ─── Auditor ─────────────────────────────────────────────────────────────────

export async function auditInstalledSkills(
  options: AuditOptions = {}
): Promise<AuditReport> {
  const threshold = options.severityThreshold ?? 'high';

  // Collect skill directories to scan
  // Includes ~/.claude/skills/ (where Claude Code skills actually live) in addition
  // to the Zora skill layers (.zora/skills/, ~/.zora/skills/, built-in)
  const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const layers = options.skillsDirs
    ? options.skillsDirs.map((d) => ({ dir: d }))
    : [{ dir: claudeSkillsDir }, ...getSkillLayers()];

  const flagged: ScanResult[] = [];
  let totalSkills = 0;

  for (const { dir } of layers) {
    let entries: string[];
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      entries = dirents.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue; // layer doesn't exist — fine
    }

    for (const skillName of entries) {
      const skillDir = path.join(dir, skillName);

      // Must contain SKILL.md to be a valid skill
      try {
        await fs.access(path.join(skillDir, 'SKILL.md'));
      } catch {
        continue;
      }

      totalSkills++;

      const result = await scanSkillDir(skillDir, { severityThreshold: threshold });
      if (!result.passed) {
        flagged.push(result);
        if (options.failFast) break;
      }
    }

    if (options.failFast && flagged.length > 0) break;
  }

  const clean = flagged.length === 0;

  const summaryLines: string[] = [
    `Skill audit: ${totalSkills} installed skill(s) checked`,
    clean
      ? `✅ All skills passed (threshold: ${threshold})`
      : `⚠️  ${flagged.length} skill(s) flagged — may have been installed without security scan`,
  ];

  for (const r of flagged) {
    summaryLines.push(formatScanReport(r));
  }

  return {
    clean,
    totalSkills,
    flaggedSkills: flagged,
    summary: summaryLines.join('\n'),
  };
}

/**
 * Lightweight check — returns true if any installed skill has critical findings.
 * Used by SessionStart hook for a fast gate without full report.
 */
export async function hasUnsafeInstalledSkills(): Promise<boolean> {
  const report = await auditInstalledSkills({
    severityThreshold: 'critical',
    failFast: true,
  });
  return !report.clean;
}
