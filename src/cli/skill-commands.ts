/**
 * Skill CLI Commands — List and inspect available Claude Code skills.
 *
 * Zora v0.6: Skills live at ~/.claude/skills/<name>/SKILL.md.
 * The SDK invokes them automatically; these commands provide
 * CLI introspection for discovery.
 */

import type { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadSkills } from '../skills/skill-loader.js';
import { installSkill } from '../skills/skill-installer.js';
import { auditInstalledSkills } from '../skills/skill-auditor.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('skill-commands');

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command('skill')
    .description('List and inspect available Claude Code skills');

  skill
    .command('audit')
    .description('Scan all installed skills for security issues (catches manually installed skills)')
    .option('--threshold <level>', 'Report findings at this severity and above: critical|high|medium|low (default: high)', 'high')
    .option('--fail-fast', 'Stop on first critical finding')
    .action(async (opts: { threshold: string; failFast?: boolean }) => {
      const threshold = opts.threshold as 'critical' | 'high' | 'medium' | 'low';
      console.log(`Auditing installed skills (threshold: ${threshold})...\n`);

      const report = await auditInstalledSkills({
        severityThreshold: threshold,
        failFast: opts.failFast,
      });

      console.log(report.summary);

      if (!report.clean) {
        console.log('\nRun "zora-agent skill uninstall <name>" to remove flagged skills,');
        console.log('or reinstall via "zora-agent skill install <file.skill>" to get a verified version.');
        process.exit(1);
      }
    });

  skill
    .command('list')
    .description('List all available skills from ~/.claude/skills/')
    .action(async () => {
      const skillsDir = path.join(os.homedir(), '.claude', 'skills');
      const skills = await loadSkills(skillsDir);

      if (skills.length === 0) {
        console.log('No skills found in ' + skillsDir);
        return;
      }

      console.log(`Found ${skills.length} skill(s):\n`);
      const maxNameLen = Math.max(...skills.map((s) => s.name.length));

      for (const s of skills) {
        const paddedName = s.name.padEnd(maxNameLen + 2);
        console.log(`  ${paddedName}${s.description}`);
      }
    });

  skill
    .command('install')
    .description('Install a skill from a .skill or .zip package')
    .argument('<file>', 'Path to .skill or .zip file')
    .option('--project', 'Install to .zora/skills/ (project-local) instead of ~/.claude/skills/ (global)')
    .option('--force', 'Install despite security findings')
    .option('--dry-run', 'Scan only — do not install')
    .option('--threshold <level>', 'Block at this severity and above: critical|high|medium|low (default: high)', 'high')
    .action(async (file: string, opts: { project?: boolean; force?: boolean; dryRun?: boolean; threshold: string }) => {
      const absFile = path.resolve(file);
      try {
        await fs.access(absFile);
      } catch {
        console.error(`File not found: ${absFile}`);
        process.exit(1);
      }

      const threshold = opts.threshold as 'critical' | 'high' | 'medium' | 'low';
      const validThresholds = ['critical', 'high', 'medium', 'low'];
      if (!validThresholds.includes(threshold)) {
        console.error(`Invalid threshold "${threshold}". Use: ${validThresholds.join(', ')}`);
        process.exit(1);
      }

      console.log(`Scanning ${path.basename(absFile)}...`);

      try {
        const result = await installSkill(absFile, {
          target: opts.project ? 'project' : 'global',
          severityThreshold: threshold,
          force: opts.force,
          dryRun: opts.dryRun,
        });

        console.log(result.report);

        if (result.installed) {
          console.log(`\n✅ Installed: ${result.skillName}`);
          console.log(`   Path: ${result.installPath}`);
          if (!result.scanPassed) {
            console.log(`   ⚠️  Installed with findings (--force)`);
          }
        } else if (result.blockedBy) {
          console.error(`\n❌ Install blocked: ${result.blockedBy}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  skill
    .command('info')
    .description('Show details about a specific skill')
    .argument('<name>', 'Skill name')
    .action(async (name: string) => {
      const skillsDir = path.join(os.homedir(), '.claude', 'skills');
      const skills = await loadSkills(skillsDir);
      const found = skills.find((s) => s.name === name);

      if (!found) {
        log.error({ name, skillsDir }, 'Skill not found');
        const similar = skills.filter((s) => s.name.includes(name));
        if (similar.length > 0) {
          log.info({ suggestions: similar.map((s) => s.name) }, 'Did you mean one of these?');
        }
        process.exit(1);
      }

      console.log(`Name:        ${found.name}`);
      console.log(`Description: ${found.description}`);
      console.log(`Path:        ${found.path}`);

      // Show first few lines of the skill content
      try {
        const content = await fs.readFile(found.path, 'utf-8');
        const lines = content.split('\n');
        // Skip frontmatter
        let startLine = 0;
        if (lines[0] === '---') {
          const endIdx = lines.indexOf('---', 1);
          if (endIdx > 0) startLine = endIdx + 1;
        }
        const preview = lines.slice(startLine, startLine + 5).join('\n').trim();
        if (preview) {
          console.log(`\nPreview:\n  ${preview.split('\n').join('\n  ')}`);
        }
      } catch {
        // Skip preview on read error
      }
    });
}
