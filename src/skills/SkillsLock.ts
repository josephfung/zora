/**
 * SkillsLock — Integrity manifest for synthesized skills.
 *
 * Maintains ~/.zora/skills/skills.lock.json, which maps each saved skill
 * slug to the SHA-256 hash of its SKILL.md content.  This lets future
 * runs verify that a file on disk has not been externally modified and
 * that the recorded slug is genuine.
 *
 * The manifest is a plain JSON object:
 *   { "slug": "sha256-hex", ... }
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ─── Types ────────────────────────────────────────────────────────────

/** Shape of skills.lock.json on disk */
export type LockFileData = Record<string, string>;

// ─── SkillsLock ───────────────────────────────────────────────────────

export class SkillsLock {
  private readonly _lockPath: string;

  constructor(baseDir?: string) {
    const skillsDir = path.join(baseDir ?? path.join(os.homedir(), '.zora'), 'skills');
    this._lockPath = path.join(skillsDir, 'skills.lock.json');
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Load the lock file from disk.
   * Returns an empty object if the file does not exist or is unparseable.
   */
  async load(): Promise<LockFileData> {
    try {
      const raw = await fs.readFile(this._lockPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as LockFileData;
      }
      return {};
    } catch {
      return {};
    }
  }

  /**
   * Save the lock data to disk atomically (tmpfile → rename).
   */
  async save(data: LockFileData): Promise<void> {
    const dir = path.dirname(this._lockPath);
    await fs.mkdir(dir, { recursive: true });

    const tmp = `${this._lockPath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await fs.rename(tmp, this._lockPath);
  }

  /**
   * Verify that the given content's SHA-256 hash matches the stored hash
   * for the named skill.  Returns false if the skill is not in the lock file.
   */
  async verify(name: string, content: string): Promise<boolean> {
    const data = await this.load();
    const stored = data[name];
    if (stored === undefined) return false;
    return stored === hashContent(content);
  }

  /**
   * Update (or insert) the hash entry for a skill.
   * Serializes per lock-file path to prevent concurrent read-modify-write races.
   */
  async update(name: string, content: string): Promise<void> {
    const ctor = this.constructor as typeof SkillsLock & {
      _writeQueues?: Map<string, Promise<void>>;
    };
    ctor._writeQueues ??= new Map<string, Promise<void>>();

    const previous = ctor._writeQueues.get(this._lockPath) ?? Promise.resolve();
    const next = previous.then(async () => {
      const data = await this.load();
      data[name] = hashContent(content);
      await this.save(data);
    });

    ctor._writeQueues.set(this._lockPath, next.catch(() => {}));
    await next;
  }
}

// ─── Utility ──────────────────────────────────────────────────────────

/** Compute the SHA-256 hex digest of a UTF-8 string. */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}
