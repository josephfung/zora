/**
 * SkillScanner — Security scanner for .skill / .zip packages before install.
 *
 * Scans extracted skill directories using:
 * - @nodesecure/js-x-ray: AST-based analysis of JS/TS scripts
 * - Custom checks: SKILL.md allowed-tools validation, shell script patterns,
 *   hardcoded secrets, curl|bash patterns
 *
 * Agent Skills spec: https://agentskills.io/specification
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AstAnalyser } from '@nodesecure/js-x-ray';

// ─── Types ──────────────────────────────────────────────────────────────────

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ScanFinding {
  severity: FindingSeverity;
  file: string;
  line?: number;
  kind: string;
  message: string;
}

export interface ScanResult {
  skillName: string;
  passed: boolean;         // true if no findings >= severityThreshold
  findings: ScanFinding[];
  scannedFiles: number;
}

// ─── Severity Maps ──────────────────────────────────────────────────────────

// js-x-ray warning kind → severity
const JS_WARNING_SEVERITY: Record<string, FindingSeverity> = {
  'obfuscated-code':      'critical',
  'data-exfiltration':    'critical',
  'serialize-environment':'critical',
  'encoded-literal':      'high',
  'unsafe-stmt':          'high',    // eval, Function()
  'unsafe-import':        'high',
  'unsafe-command':       'high',
  'shady-link':           'medium',
  'suspicious-literal':   'medium',
  'suspicious-file':      'medium',
  'weak-crypto':          'medium',
  'unsafe-regex':         'low',
  'short-identifiers':    'low',
  'synchronous-io':       'info',
  'parsing-error':        'info',
};

// allowed-tools entries that should block install at high severity
// NOTE: Bash(*) is intentionally excluded here — it has its own critical check below
// to avoid being downgraded to high by the deduplication step
const DANGEROUS_TOOL_PATTERNS = [
  /Bash\(sudo/i,
  /Bash\(rm\b/i,
  /Bash\(curl\b/i,
  /Bash\(wget\b/i,
  /Bash\(chmod\b/i,
  /Bash\(chown\b/i,
];

// Shell script dangerous patterns (regex → message)
const SHELL_DANGER_PATTERNS: Array<{ re: RegExp; severity: FindingSeverity; message: string }> = [
  { re: /curl\s+[^|]*\|\s*(ba)?sh/i,      severity: 'critical', message: 'curl | bash — remote code execution pattern' },
  { re: /wget\s+[^|]*\|\s*(ba)?sh/i,      severity: 'critical', message: 'wget | bash — remote code execution pattern' },
  { re: /eval\s*\$\(/,                     severity: 'high',     message: 'eval $(...) — dynamic shell execution' },
  { re: /base64\s+(-d|--decode)/i,         severity: 'high',     message: 'base64 decode — possible obfuscated payload' },
  { re: /\/dev\/tcp\//,                    severity: 'critical', message: '/dev/tcp reverse shell pattern' },
  { re: /(ANTHROPIC|OPENAI|AWS|GITHUB)_.*KEY/i, severity: 'high', message: 'Possible hardcoded API key or credential' },
];

// Hardcoded secret patterns for any file
const SECRET_PATTERNS: Array<{ re: RegExp; severity: FindingSeverity; message: string }> = [
  { re: /sk-[A-Za-z0-9]{20,}/,            severity: 'high',     message: 'Possible OpenAI/Anthropic API key' },
  { re: /AKIA[A-Z0-9]{16}/,               severity: 'high',     message: 'Possible AWS access key' },
  { re: /ghp_[A-Za-z0-9]{36}/,            severity: 'high',     message: 'Possible GitHub personal access token' },
  { re: /xoxb-[A-Za-z0-9\-]+/,           severity: 'high',     message: 'Possible Slack bot token' },
];

export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 4, high: 3, medium: 2, low: 1, info: 0,
};

// ─── File Helpers ────────────────────────────────────────────────────────────

const MAX_WALK_DEPTH = 10;

async function walkDir(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...await walkDir(full, depth + 1));
    } else {
      files.push(full);
    }
  }
  return files;
}

// ─── Individual Scanners ─────────────────────────────────────────────────────

function scanJsTs(code: string, relPath: string): ScanFinding[] {
  const analyser = new AstAnalyser();
  let result;
  try {
    result = analyser.analyse(code, { isMinified: false });
  } catch {
    return []; // parse error — js-x-ray handles parsing-error in warnings
  }

  return result.warnings.map((w): ScanFinding => ({
    severity: JS_WARNING_SEVERITY[w.kind as string] ?? 'low',
    file: relPath,
    line: Array.isArray(w.location) ? (w.location[0] as [number, number])?.[0] : undefined,
    kind: String(w.kind),
    message: `${w.kind}${'value' in w && w.value ? ': ' + String(w.value) : ''}`,
  }));
}

function scanShell(code: string, relPath: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = code.split('\n');
  for (const { re, severity, message } of SHELL_DANGER_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        findings.push({ severity, file: relPath, line: i + 1, kind: 'shell-pattern', message });
      }
    }
  }
  return findings;
}

function scanSecrets(code: string, relPath: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = code.split('\n');
  for (const { re, severity, message } of SECRET_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        findings.push({ severity, file: relPath, line: i + 1, kind: 'hardcoded-secret', message });
      }
    }
  }
  return findings;
}

function scanAllowedTools(frontmatter: string, relPath: string): ScanFinding[] {
  const lines = frontmatter.split('\n');
  const startIdx = lines.findIndex((line) => /allowed-tools\s*:/.test(line));
  if (startIdx === -1) return [];

  // Collect the full allowed-tools block including YAML list items on subsequent lines
  // Stop when we hit the next YAML key (non-indented line that looks like "key:")
  const toolsLines: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (i !== startIdx && /^[A-Za-z_-]+\s*:/.test(line)) break;
    toolsLines.push(line);
  }
  const toolsBlock = toolsLines.join('\n');
  const findings: ScanFinding[] = [];

  // Bash(*) is critical — check first, dedupe key differs from generic high findings
  if (/Bash\(\*\)/.test(toolsBlock)) {
    findings.push({
      severity: 'critical',
      file: relPath,
      kind: 'dangerous-allowed-tools-wildcard',
      message: 'SKILL.md declares Bash(*) — unrestricted shell access',
    });
  }

  // Other dangerous patterns → high
  for (const pattern of DANGEROUS_TOOL_PATTERNS) {
    if (pattern.test(toolsBlock)) {
      findings.push({
        severity: 'high',
        file: relPath,
        kind: 'dangerous-allowed-tools',
        message: `SKILL.md declares dangerous allowed-tools: ${toolsLines[0]!.trim()}`,
      });
      break; // one high finding per block is enough
    }
  }

  return findings;
}

// ─── Main Scanner ────────────────────────────────────────────────────────────

export async function scanSkillDir(
  skillDir: string,
  options: { severityThreshold?: FindingSeverity } = {}
): Promise<ScanResult> {
  const threshold = options.severityThreshold ?? 'high';
  const thresholdRank = SEVERITY_RANK[threshold];

  const allFiles = await walkDir(skillDir);
  const findings: ScanFinding[] = [];
  let scannedFiles = 0;

  // Detect skill name from directory
  const skillName = path.basename(skillDir);

  for (const absPath of allFiles) {
    const relPath = path.relative(skillDir, absPath);
    const ext = path.extname(absPath).toLowerCase();
    let code: string;

    try {
      code = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    scannedFiles++;

    // JS/TS AST scan
    if (['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) {
      findings.push(...scanJsTs(code, relPath));
    }

    // Shell script scan
    if (['.sh', '.bash', '.zsh'].includes(ext) || relPath.startsWith('scripts/')) {
      findings.push(...scanShell(code, relPath));
    }

    // SKILL.md — validate frontmatter + allowed-tools
    if (path.basename(absPath) === 'SKILL.md') {
      const frontmatterMatch = code.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        findings.push(...scanAllowedTools(frontmatterMatch[1]!, relPath));
      }
    }

    // Secret scan on all text files
    if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.sh', '.bash', '.py', '.md', '.env', '.toml', '.yaml', '.yml'].includes(ext)) {
      findings.push(...scanSecrets(code, relPath));
    }
  }

  // Deduplicate exact duplicates
  const unique = findings.filter((f, i, arr) =>
    arr.findIndex((x) => x.file === f.file && x.line === f.line && x.kind === f.kind) === i
  );

  // Sort by severity desc
  unique.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const passed = !unique.some((f) => SEVERITY_RANK[f.severity] >= thresholdRank);

  return { skillName, passed, findings: unique, scannedFiles };
}

export function formatScanReport(result: ScanResult): string {
  const icon: Record<FindingSeverity, string> = {
    critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪',
  };

  const lines: string[] = [
    `\nScan: ${result.skillName} (${result.scannedFiles} files)`,
    result.passed ? '✅ Passed' : '❌ Blocked — findings above threshold',
  ];

  if (result.findings.length === 0) {
    lines.push('  No findings.');
  } else {
    for (const f of result.findings) {
      const loc = f.line ? `:${f.line}` : '';
      lines.push(`  ${icon[f.severity]} [${f.severity.toUpperCase()}] ${f.file}${loc} — ${f.message}`);
    }
  }

  return lines.join('\n');
}
