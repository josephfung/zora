/**
 * SkillInstaller — Extracts and installs .skill / .zip packages.
 *
 * A .skill file is a renamed .zip containing a skill directory:
 *   skill-name/
 *     SKILL.md      (required)
 *     scripts/      (optional)
 *     references/   (optional)
 *     assets/       (optional)
 *
 * Flow:
 *   1. Validate extension (.skill or .zip)
 *   2. Extract to temp dir
 *   3. Validate structure (SKILL.md present, name matches dir)
 *   4. Run security scan
 *   5. If clean (or --force): move to target skills dir
 *   6. Cleanup temp dir
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { scanSkillDir, formatScanReport, type FindingSeverity } from './skill-scanner.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InstallOptions {
  /** Install to .zora/skills/ (project-local) instead of ~/.claude/skills/ (global) */
  target?: 'global' | 'project';
  /** Block installs with findings at or above this severity (default: high) */
  severityThreshold?: FindingSeverity;
  /** Install despite security findings */
  force?: boolean;
  /** Scan only — do not install */
  dryRun?: boolean;
  /** Override project directory for 'project' target (defaults to cwd) */
  cwd?: string;
}

export interface InstallResult {
  skillName: string;
  installed: boolean;
  installPath?: string;
  scanPassed: boolean;
  report: string;
  blockedBy?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTargetDir(options: InstallOptions): string {
  if (options.target === 'project') {
    return path.join(options.cwd ?? process.cwd(), '.zora', 'skills');
  }
  return path.join(os.homedir(), '.claude', 'skills');
}

/** Parse name from SKILL.md frontmatter */
async function readSkillName(skillMdPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(skillMdPath, 'utf-8');
    const match = content.match(/^---\n[\s\S]*?name:\s*([^\n]+)/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

// ─── Installer ───────────────────────────────────────────────────────────────

export async function installSkill(
  skillFilePath: string,
  options: InstallOptions = {}
): Promise<InstallResult> {
  const ext = path.extname(skillFilePath).toLowerCase();
  if (ext !== '.skill' && ext !== '.zip') {
    throw new Error(`Expected a .skill or .zip file, got: ${ext}`);
  }

  // 1. Extract to temp dir
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zora-skill-'));

  try {
    let zip: AdmZip;
    try {
      zip = new AdmZip(skillFilePath);
    } catch (err) {
      throw new Error(`Cannot read archive: ${err instanceof Error ? err.message : String(err)}`);
    }

    zip.extractAllTo(tempDir, true);

    // 2. Find the skill directory inside the extracted content
    //    The archive should contain exactly one top-level directory.
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    if (dirs.length === 0) {
      throw new Error('Archive contains no directory. Expected: skill-name/SKILL.md');
    }
    if (dirs.length > 1) {
      throw new Error(
        `Archive contains ${dirs.length} top-level directories. Expected exactly one skill directory.`
      );
    }

    const skillDir = path.join(tempDir, dirs[0]!.name);
    const dirName = dirs[0]!.name;

    // 3. Validate SKILL.md present
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    try {
      await fs.access(skillMdPath);
    } catch {
      throw new Error(`Archive is missing SKILL.md in ${dirName}/. Not a valid skill package.`);
    }

    // 4. Validate name in SKILL.md matches directory name
    const declaredName = await readSkillName(skillMdPath);
    if (declaredName && declaredName !== dirName) {
      throw new Error(
        `SKILL.md declares name: "${declaredName}" but directory is named "${dirName}". ` +
        `Per spec, they must match.`
      );
    }

    const skillName = declaredName ?? dirName;

    // 5. Security scan
    const scanResult = await scanSkillDir(skillDir, {
      severityThreshold: options.severityThreshold ?? 'high',
    });
    const report = formatScanReport(scanResult);

    if (!scanResult.passed && !options.force) {
      return {
        skillName,
        installed: false,
        scanPassed: false,
        report,
        blockedBy: `${scanResult.findings.filter((f) => ['critical', 'high'].includes(f.severity)).length} critical/high finding(s). Use --force to override.`,
      };
    }

    if (options.dryRun) {
      return {
        skillName,
        installed: false,
        scanPassed: scanResult.passed,
        report: report + '\n\n[dry-run] Scan complete. Not installed.',
      };
    }

    // 6. Install — move skill dir to target
    const targetBase = getTargetDir(options);
    await fs.mkdir(targetBase, { recursive: true });
    const installPath = path.join(targetBase, dirName);

    // If skill already exists, remove it first
    try {
      await fs.rm(installPath, { recursive: true, force: true });
    } catch {
      // ignore
    }

    await fs.cp(skillDir, installPath, { recursive: true });

    return {
      skillName,
      installed: true,
      installPath,
      scanPassed: scanResult.passed,
      report,
    };
  } finally {
    // Always clean up temp dir
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
