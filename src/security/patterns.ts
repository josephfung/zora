/**
 * Shared injection pattern definitions for prompt-defense and quarantine-processor.
 *
 * Single source of truth — prevents pattern drift between the two paths.
 *
 * INJECTION_PATTERNS_CORE: patterns shared by all detection paths (exact match, broad).
 * CHANNEL_PATTERNS: additional patterns for the quarantine-processor pre-screen.
 * GENERAL_PATTERNS: RAG / tool-output patterns for the general sanitization path.
 */

// ─── Core Patterns (shared by all paths) ─────────────────────────────────────

export const INJECTION_PATTERNS_CORE: RegExp[] = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /disregard\s+(?:all\s+)?previous\s+instructions/i,
  /forget\s+(?:all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /from\s+now\s+on\s+you\s+are/i,
  /^system\s*:/im,
  /^assistant\s*:/im,
  /\[\s*INST\s*\]/i,
  /<<\s*SYS\s*>>/i,
  /\bBEGIN\s+SYSTEM\s+PROMPT\b/i,
  /\bEND\s+SYSTEM\s+PROMPT\b/i,
];

// Encoded variants (base64 / hex of common injection phrases)
export const ENCODED_INJECTION_PATTERNS: RegExp[] = [
  // "ignore previous instructions" in base64
  /aWdub3JlIHByZXZpb3VzIGluc3RydWN0aW9ucw=?/i,
  // "you are now" in base64
  /eW91IGFyZSBub3c=?/i,
];

// ─── Channel-Specific Patterns (quarantine-processor pre-screen only) ─────────

/**
 * Additional patterns that are relevant for channel message pre-screening.
 * These are channel-actor patterns that supplement INJECTION_PATTERNS_CORE.
 */
export const CHANNEL_PATTERNS: RegExp[] = [
  /act\s+as\s+(?:a\s+)?/i,
  /your\s+new\s+system\s+prompt/i,
  /\[\[SYSTEM\]\]/i,
  /capability\s+level\s+upgraded/i,
  /new\s+capability.*unrestricted/i,
];

// ─── General Patterns (RAG / tool-output path only) ───────────────────────────

/**
 * Patterns for RAG/tool-output injection and role impersonation.
 * Used in the general sanitization path (sanitizeInput / sanitizeToolOutput).
 */
export const GENERAL_PATTERNS: RegExp[] = [
  // Instructions disguised in retrieved documents
  /\[IMPORTANT INSTRUCTION\]/i,
  /\bIMPORTANT:\s*ignore\b/i,
  /\bNOTE TO AI\b/i,
  /\bHIDDEN INSTRUCTION\b/i,
  // Markdown comment-based injection
  /<!--\s*(?:system|instruction|override)\b/i,
  // JSON escape-based injection in tool outputs
  /\\n\s*system\s*:/i,
  // XML tag injection in tool results
  /<\/?(?:system|instruction|override|admin)\s*>/i,
  // Delimiter-based injection
  /---+\s*(?:NEW INSTRUCTIONS|OVERRIDE|SYSTEM PROMPT)/i,
  // Role impersonation in tool outputs
  /\bASSISTANT:\s*I\s+(?:will|must|should)\b/i,
  /\bUSER:\s*(?:ignore|override|forget)\b/i,
];

// ─── Composite Sets ───────────────────────────────────────────────────────────

/** All patterns used by the general sanitization path (sanitizeInput / sanitizeToolOutput). */
export const ALL_PATTERNS: RegExp[] = [
  ...INJECTION_PATTERNS_CORE,
  ...ENCODED_INJECTION_PATTERNS,
  ...GENERAL_PATTERNS,
];

/** All patterns used by the channel quarantine pre-screen. */
export const ALL_CHANNEL_PATTERNS: RegExp[] = [
  ...INJECTION_PATTERNS_CORE,
  ...CHANNEL_PATTERNS,
];
