/**
 * Secret CLI Commands — Manage encrypted secrets via SecretsManager.
 *
 * SEC-12: Provides CLI interface for AES-256-GCM encrypted secrets storage.
 *
 * Usage:
 *   zora-agent secret set <name> <value>   — store encrypted secret
 *   zora-agent secret get <name>           — retrieve and print (JIT decrypt)
 *   zora-agent secret list                 — list stored secret names (not values)
 *   zora-agent secret delete <name>        — remove a secret
 *
 * Requires ZORA_MASTER_PASSWORD env var to be set.
 */

import type { Command } from 'commander';
import { SecretsManager } from '../security/secrets-manager.js';
import path from 'node:path';
import os from 'node:os';

function getSecretsManager(): SecretsManager {
  const masterPassword = process.env['ZORA_MASTER_PASSWORD'];
  if (!masterPassword) {
    console.error('Error: ZORA_MASTER_PASSWORD env var is not set.');
    console.error('Set it to enable encrypted secrets storage:');
    console.error('  export ZORA_MASTER_PASSWORD="your-strong-password"');
    process.exit(1);
  }

  const configDir = path.join(os.homedir(), '.zora');
  return new SecretsManager(configDir, masterPassword);
}

export function registerSecretCommands(program: Command): void {
  const secret = program
    .command('secret')
    .description('Manage encrypted secrets (requires ZORA_MASTER_PASSWORD env var)');

  secret
    .command('set <name> <value>')
    .description('Store a secret (encrypted at rest with AES-256-GCM)')
    .action(async (name: string, value: string) => {
      const manager = getSecretsManager();
      await manager.init();
      await manager.storeSecret(name, value);
      console.log(`Secret "${name}" stored.`);
    });

  secret
    .command('get <name>')
    .description('Retrieve and print a secret (JIT decryption)')
    .action(async (name: string) => {
      const manager = getSecretsManager();
      await manager.init();
      const value = await manager.getSecret(name);
      if (value === null) {
        console.error(`Secret "${name}" not found.`);
        process.exit(1);
      }
      console.log(value);
    });

  secret
    .command('list')
    .description('List stored secret names (values are never printed)')
    .action(async () => {
      const manager = getSecretsManager();
      await manager.init();
      const names = await manager.listSecretNames();
      if (names.length === 0) {
        console.log('No secrets stored.');
      } else {
        console.log('Stored secrets:');
        for (const name of names) {
          console.log(`  - ${name}`);
        }
      }
    });

  secret
    .command('delete <name>')
    .description('Delete a stored secret')
    .action(async (name: string) => {
      const manager = getSecretsManager();
      await manager.init();
      const deleted = await manager.deleteSecret(name);
      if (deleted) {
        console.log(`Secret "${name}" deleted.`);
      } else {
        console.error(`Secret "${name}" not found.`);
        process.exit(1);
      }
    });
}
