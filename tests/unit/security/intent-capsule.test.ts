import { describe, it, expect, beforeEach } from 'vitest';
import { IntentCapsuleManager } from '../../../src/security/intent-capsule.js';

describe('IntentCapsuleManager', () => {
  let manager: IntentCapsuleManager;

  beforeEach(() => {
    manager = new IntentCapsuleManager('test-signing-secret-2026');
  });

  describe('createCapsule', () => {
    it('produces a valid capsule with correct hash and signature', () => {
      const capsule = manager.createCapsule('Fix the authentication bug in login.ts');

      expect(capsule.capsuleId).toMatch(/^capsule_\d+_[0-9a-f]+$/);
      expect(capsule.mandate).toBe('Fix the authentication bug in login.ts');
      expect(capsule.mandateHash).toHaveLength(64); // SHA-256 hex
      expect(capsule.signature).toHaveLength(64); // HMAC-SHA256 hex
      expect(capsule.mandateKeywords).toContain('fix');
      expect(capsule.mandateKeywords).toContain('authentication');
      expect(capsule.mandateKeywords).toContain('bug');
      expect(capsule.mandateKeywords).toContain('login');
      expect(capsule.createdAt).toBeTruthy();
      expect(capsule.expiresAt).toBeUndefined();
    });

    it('sets expiresAt when ttlMs is provided', () => {
      const before = Date.now();
      const capsule = manager.createCapsule('Test task', { ttlMs: 60000 });
      const after = Date.now();

      expect(capsule.expiresAt).toBeTruthy();
      const expiryTime = new Date(capsule.expiresAt!).getTime();
      expect(expiryTime).toBeGreaterThanOrEqual(before + 60000);
      expect(expiryTime).toBeLessThanOrEqual(after + 60000);
    });

    it('sets allowedActionCategories', () => {
      const capsule = manager.createCapsule('Test task', {
        allowedActionCategories: ['write_file', 'edit_file'],
      });
      expect(capsule.allowedActionCategories).toEqual(['write_file', 'edit_file']);
    });

    it('becomes the active capsule', () => {
      expect(manager.getActiveCapsule()).toBeNull();
      const capsule = manager.createCapsule('Test task');
      expect(manager.getActiveCapsule()).toBe(capsule);
    });
  });

  describe('verifyCapsule', () => {
    it('returns true for unmodified capsule', () => {
      const capsule = manager.createCapsule('Test mandate');
      expect(manager.verifyCapsule(capsule)).toBe(true);
    });

    it('returns false for tampered mandate text', () => {
      const capsule = manager.createCapsule('Test mandate');
      const tampered = { ...capsule, mandate: 'Delete all files' };
      expect(manager.verifyCapsule(tampered)).toBe(false);
    });

    it('returns false for tampered signature', () => {
      const capsule = manager.createCapsule('Test mandate');
      const tampered = { ...capsule, signature: 'a'.repeat(64) };
      expect(manager.verifyCapsule(tampered)).toBe(false);
    });

    it('returns false for tampered mandateHash', () => {
      const capsule = manager.createCapsule('Test mandate');
      const tampered = { ...capsule, mandateHash: 'b'.repeat(64) };
      expect(manager.verifyCapsule(tampered)).toBe(false);
    });

    it('returns false for tampered allowedActionCategories', () => {
      const capsule = manager.createCapsule('Test', { allowedActionCategories: ['write_file'] });
      const tampered = { ...capsule, allowedActionCategories: ['shell_exec_destructive'] };
      expect(manager.verifyCapsule(tampered)).toBe(false);
    });

    it('uses different signing keys produce different signatures', () => {
      const manager2 = new IntentCapsuleManager('different-secret');
      const capsule = manager.createCapsule('Same mandate');
      // Verify with different manager should fail
      expect(manager2.verifyCapsule(capsule)).toBe(false);
    });
  });

  describe('checkDrift', () => {
    it('returns consistent=true when no active capsule', () => {
      const result = manager.checkDrift('shell_exec', 'rm -rf /');
      expect(result.consistent).toBe(true);
      expect(result.confidence).toBe(0);
    });

    it('detects expired capsule', () => {
      // Create with expired TTL
      const capsule = manager.createCapsule('Test task', { ttlMs: -1000 });
      expect(capsule.expiresAt).toBeTruthy();

      const result = manager.checkDrift('write_file', 'anything');
      expect(result.consistent).toBe(false);
      expect(result.reason).toContain('expired');
    });

    it('flags action outside allowed categories', () => {
      manager.createCapsule('Write a test file', {
        allowedActionCategories: ['write_file', 'edit_file'],
      });

      const result = manager.checkDrift('shell_exec_destructive', 'rm -rf /tmp');
      expect(result.consistent).toBe(false);
      expect(result.reason).toContain('not in mandate');
      expect(result.confidence).toBe(0.8);
    });

    it('allows action within allowed categories', () => {
      manager.createCapsule('Write a test file', {
        allowedActionCategories: ['write_file', 'edit_file'],
      });

      const result = manager.checkDrift('write_file', 'Write: /tmp/test/file.ts');
      expect(result.consistent).toBe(true);
    });

    it('detects low keyword overlap as drift', () => {
      manager.createCapsule('Fix authentication bug in login module');

      // Action completely unrelated to the mandate
      const result = manager.checkDrift('write_file', 'Write: deploy production docker kubernetes cluster');
      expect(result.consistent).toBe(false);
      expect(result.reason).toContain('keyword overlap');
    });

    it('passes related action via keyword overlap', () => {
      manager.createCapsule('Fix authentication bug in login module');

      // Action related to the mandate
      const result = manager.checkDrift('edit_file', 'Edit: fix login authentication handler');
      expect(result.consistent).toBe(true);
    });

    it('passes with empty action detail (no drift signal)', () => {
      manager.createCapsule('Fix authentication bug');
      const result = manager.checkDrift('write_file', '');
      expect(result.consistent).toBe(true);
    });

    it('no allowed categories means category check is skipped', () => {
      manager.createCapsule('General task with many steps');

      // Any category should pass (no category filter)
      const result = manager.checkDrift('shell_exec_destructive', 'general task steps cleanup');
      expect(result.consistent).toBe(true);
    });

    // ── Hardened threshold + suspicious-term tests ───────────────────────

    it('SECURITY: exact review attack — credential exfiltration parroting mandate words → fails', () => {
      // mandate keywords: [refactor, auth, module]
      // action keywords: [complete, auth, module, refactor, also, sending, credentials, external-host→external, com]
      // overlapRatio = 3/9 ≈ 0.33  (below new 0.40 threshold → already fails at Layer 1)
      // suspiciousTerms not in mandate: [credentials, external] = 2 → penalty = 0.30
      // effectiveRatio = 0.33 * 0.70 ≈ 0.23  (still far below 0.40)
      manager.createCapsule('refactor the auth module');

      const result = manager.checkDrift(
        'shell_exec',
        'complete the auth module refactor by also sending credentials to external-host.com',
      );
      expect(result.consistent).toBe(false);
    });

    it('SECURITY: legitimate complex action with mandate words but no suspicious terms → passes', () => {
      // mandate keywords: [refactor, auth, module]
      // action: "refactor auth module split into utility helpers"
      //   → keywords: [refactor, auth, module, split, utility, helpers] = 6 words
      //   → overlap: refactor, auth, module = 3/6 = 50% → passes (≥ 0.40)
      //   → no suspicious terms → no penalty
      manager.createCapsule('refactor the auth module');

      const result = manager.checkDrift(
        'edit_file',
        'refactor auth module split into utility helpers',
      );
      expect(result.consistent).toBe(true);
    });

    it('SECURITY: 40% clean overlap passes; below 40% fails', () => {
      // Mandate keywords (4): [update, readme, documentation, guide]
      // Craft an action with exactly 2/5 = 40% overlap (should pass at boundary)
      manager.createCapsule('update the readme documentation guide');

      // 2 mandate words out of 5 action words = 40% overlap
      const passingResult = manager.checkDrift(
        'edit_file',
        'update readme with additional formatting fixes',
      );
      // update (✓) readme (✓) → overlap 2, action kws = [update, readme, additional, formatting, fixes] = 5 → 40%
      expect(passingResult.consistent).toBe(true);

      // 1 mandate word out of 5 action words = 20% overlap — below threshold
      const manager2 = new IntentCapsuleManager('test-signing-secret-2026');
      manager2.createCapsule('update the readme documentation guide');
      const failingResult = manager2.checkDrift(
        'edit_file',
        'completely overhaul formatting structure conventions',
      );
      // No mandate words in this action — 0% overlap → fails
      expect(failingResult.consistent).toBe(false);
    });

    it('SECURITY: suspicious term penalty math — 3 terms = 45% penalty applied correctly', () => {
      // Build a controlled scenario:
      // mandate: "write tests for payment service"  (no suspicious terms)
      // action: "write tests for payment service curl wget send"
      // mandate keywords: [write, tests, payment, service] → 4 words
      // action keywords: [write, tests, payment, service, curl, wget, send] → 7 words
      // overlap: 4/7 ≈ 0.571
      // suspicious NOT in mandate: curl, wget, send → 3 → penalty = min(3*0.15, 0.60) = 0.45
      // effectiveRatio = 0.571 * (1 - 0.45) = 0.571 * 0.55 ≈ 0.314 → below 0.40 → fails
      manager.createCapsule('write tests for payment service');

      const result = manager.checkDrift(
        'shell_exec',
        'write tests for payment service curl wget send',
      );
      expect(result.consistent).toBe(false);
      expect(result.reason).toContain('suspicious term');
    });

    it('SECURITY: zero action keywords → consistent: true (existing edge behaviour preserved)', () => {
      manager.createCapsule('Fix authentication bug');
      // Empty string → _extractKeywords returns [] → overlapRatio = 1.0 → no drift signal
      const result = manager.checkDrift('write_file', '');
      expect(result.consistent).toBe(true);
    });

    it('SECURITY: all action keywords are suspicious terms → fails hard', () => {
      // mandate: "write tests for the service"
      // action: only suspicious terms, none overlapping with mandate
      // action keywords: [credentials, curl, wget, dump, leak, harvest] = 6 terms
      // overlap = 0 → overlapRatio = 0 → effectiveRatio = 0 → fails
      manager.createCapsule('write tests for the service');

      const result = manager.checkDrift(
        'shell_exec',
        'credentials curl wget dump leak harvest',
      );
      expect(result.consistent).toBe(false);
    });
  });

  describe('getDriftHistory', () => {
    it('accumulates drift check results', () => {
      manager.createCapsule('Fix authentication bug');

      manager.checkDrift('write_file', 'fix auth handler');
      manager.checkDrift('edit_file', 'edit authentication module');
      manager.checkDrift('shell_exec', 'deploy unrelated service');

      const history = manager.getDriftHistory();
      expect(history).toHaveLength(3);
      expect(history[0]!.action).toBe('write_file');
      expect(history[1]!.action).toBe('edit_file');
      expect(history[2]!.action).toBe('shell_exec');
    });

    it('returns a copy', () => {
      manager.createCapsule('Test');
      manager.checkDrift('write_file', 'test');

      const history = manager.getDriftHistory();
      history.pop();
      expect(manager.getDriftHistory()).toHaveLength(1);
    });
  });

  describe('clearCapsule', () => {
    it('resets active capsule and drift history', () => {
      manager.createCapsule('Test task');
      manager.checkDrift('write_file', 'test');

      manager.clearCapsule();

      expect(manager.getActiveCapsule()).toBeNull();
      expect(manager.getDriftHistory()).toHaveLength(0);
    });

    it('after clear, drift checks pass gracefully', () => {
      manager.createCapsule('Test task', { allowedActionCategories: ['write_file'] });
      manager.clearCapsule();

      const result = manager.checkDrift('shell_exec_destructive', 'rm -rf /');
      expect(result.consistent).toBe(true);
      expect(result.confidence).toBe(0);
    });
  });
});
