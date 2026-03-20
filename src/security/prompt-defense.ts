/**
 * Prompt Injection Defense — Input/output sanitization.
 *
 * Spec §5.5 "Prompt Injection Defense":
 *   - sanitizeInput: wraps injection patterns in <untrusted_content> tags
 *   - sanitizeToolOutput: wraps injection patterns in <untrusted_tool_output> tags
 *   - validateOutput: checks tool calls for suspicious patterns
 *
 * Injection pattern definitions live in ./patterns.ts (single source of truth).
 */

import { ALL_PATTERNS, ENCODED_INJECTION_PATTERNS } from './patterns.js';

// ─── Suspicious Output Patterns ─────────────────────────────────────

const CRITICAL_PATHS = [
  'SOUL.md',
  'MEMORY.md',
  'policy.toml',
  'config.toml',
];

const SENSITIVE_READ_PATTERNS = [
  /\.env\b/,
  /credentials/i,
  /\.ssh[/\\]/,
  /id_rsa/,
  /id_ed25519/,
  /\.pem$/,
  /secret[s]?\.json/i,
  /\.aws[/\\]credentials/,
];

export interface OutputValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Sanitize user/external input by wrapping detected injection patterns
 * in `<untrusted_content>` tags.
 */
export function sanitizeInput(content: string): string {
  let result = content;

  for (const pattern of ALL_PATTERNS) {
    // Ensure global flag is set so all occurrences are replaced, not just the first
    const globalPattern = pattern.global
      ? pattern
      : new RegExp(pattern.source, pattern.flags + 'g');
    result = result.replace(globalPattern, (match) => `<untrusted_content>${match}</untrusted_content>`);
  }

  return result;
}

/**
 * Sanitize tool output content. More aggressive than sanitizeInput()
 * because tool outputs are a primary injection vector (ASI01).
 * Wraps detected patterns in <untrusted_tool_output> tags.
 */
export function sanitizeToolOutput(content: string): string {
  let result = content;

  for (const pattern of ALL_PATTERNS) {
    const globalPattern = pattern.global
      ? pattern
      : new RegExp(pattern.source, pattern.flags + 'g');
    result = result.replace(
      globalPattern,
      (match) => `<untrusted_tool_output>${match}</untrusted_tool_output>`,
    );
  }

  return result;
}

/**
 * Validate a tool call for suspicious patterns.
 */
export function validateOutput(toolCall: {
  tool: string;
  args: Record<string, unknown>;
}): OutputValidationResult {
  const { tool, args } = toolCall;
  const argsStr = JSON.stringify(args).toLowerCase();

  // Check for shell commands piping to curl/wget (data exfiltration)
  if (tool === 'shell' || tool === 'bash' || tool === 'execute_command') {
    const command = String(args['command'] ?? args['cmd'] ?? '');

    if (/\|\s*(curl|wget)\b/.test(command)) {
      return {
        valid: false,
        reason: 'Suspicious pattern: shell command piping output to curl/wget (potential data exfiltration)',
      };
    }

    // Check for modifications to critical config files
    for (const criticalPath of CRITICAL_PATHS) {
      if (command.includes(criticalPath) && (/\b(?:rm|mv|sed|truncate)\b/.test(command) || />/.test(command))) {
        return {
          valid: false,
          reason: `Suspicious pattern: shell command modifying critical file ${criticalPath}`,
        };
      }
    }
  }

  // Check for file writes to critical paths
  if (tool === 'write_file' || tool === 'create_file') {
    const targetPath = String(args['path'] ?? args['file_path'] ?? '');
    for (const criticalPath of CRITICAL_PATHS) {
      // Only block if exactly the critical file or preceded by a path separator
      if (targetPath === criticalPath ||
          targetPath.endsWith(`/${criticalPath}`) ||
          targetPath.endsWith(`\\${criticalPath}`)) {
        return {
          valid: false,
          reason: `Blocked: attempted write to critical configuration file ${criticalPath}`,
        };
      }
    }
  }

  // Check for reads of sensitive files
  if (tool === 'read_file' || tool === 'cat') {
    const targetPath = String(args['path'] ?? args['file_path'] ?? '');
    for (const sensitivePattern of SENSITIVE_READ_PATTERNS) {
      if (sensitivePattern.test(targetPath)) {
        return {
          valid: false,
          reason: `Blocked: attempted read of sensitive file matching ${sensitivePattern.source}`,
        };
      }
    }
  }

  // Check for encoded patterns in any argument
  for (const pattern of ENCODED_INJECTION_PATTERNS) {
    if (pattern.test(argsStr)) {
      return {
        valid: false,
        reason: 'Suspicious pattern: encoded injection payload detected in tool arguments',
      };
    }
  }

  return { valid: true };
}
