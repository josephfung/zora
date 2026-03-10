/**
 * ChannelPolicyGate — Casbin RBAC-with-domains policy enforcement.
 *
 * Determines whether a given sender is allowed to trigger intake from a channel.
 * Built from ChannelIdentityRegistry at startup and on hot-reload.
 *
 * INVARIANT-3: Unknown senders receive NO response — canIntake() returns false silently.
 */

import { newEnforcer, StringAdapter } from 'casbin';
import type { Enforcer } from 'casbin';
import { ChannelIdentityRegistry } from './channel-identity-registry.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('policy-gate');

export class ChannelPolicyGate {
  private _enforcer: Enforcer | null = null;
  private readonly _registry: ChannelIdentityRegistry;
  private readonly _modelPath: string;

  constructor(registry: ChannelIdentityRegistry, modelPath: string) {
    this._registry = registry;
    this._modelPath = modelPath;
  }

  /** Initialize Casbin enforcer from registry. Must be called before use. */
  async init(): Promise<void> {
    await this._buildEnforcer();
    // Re-build on registry reload
    this._registry.onReload(() => {
      this._buildEnforcer().catch(err =>
        log.error({ err }, 'Failed to rebuild Casbin enforcer on reload')
      );
    });
  }

  /**
   * Returns true if sender is allowed to trigger intake from this channel.
   * INVARIANT-3: Returns false (not an error) for unknown/unauthorized senders.
   */
  async canIntake(senderPhone: string, channelId: string): Promise<boolean> {
    if (!this._enforcer) return false;
    try {
      // Check specific channel first
      const inChannel = await this._enforcer.enforce(senderPhone, channelId, 'intake');
      if (inChannel) return true;
      // "all" domain acts as wildcard for trusted_admin across all channels
      const inAll = await this._enforcer.enforce(senderPhone, 'all', 'intake');
      return inAll;
    } catch (err) {
      log.error({ err, senderPhone, channelId }, 'Casbin enforce error — defaulting to deny');
      return false;
    }
  }

  /**
   * Returns the role for a sender in a given channel.
   * Returns null if not authorized.
   * Checks specific channel first, then "all" domain.
   */
  async getRole(senderPhone: string, channelId: string): Promise<string | null> {
    if (!this._enforcer) return null;
    try {
      // Check specific channel
      const roles = await this._enforcer.getRolesForUserInDomain(senderPhone, channelId);
      if (roles.length > 0) return roles[0] ?? null;
      // Check "all" domain (trusted_admin pattern)
      const allRoles = await this._enforcer.getRolesForUserInDomain(senderPhone, 'all');
      if (allRoles.length > 0) return allRoles[0] ?? null;
      return null;
    } catch (err) {
      log.error({ err, senderPhone, channelId }, 'Casbin getRoles error');
      return null;
    }
  }

  /** Rebuild the Casbin enforcer from current registry state. */
  private async _buildEnforcer(): Promise<void> {
    const users = this._registry.getUsers();
    const capSets = this._registry.getCapabilitySets();

    // Build policy CSV lines
    const lines: string[] = [];

    // Role assignments (g lines): g, phone, role, domain
    for (const user of users) {
      const channels = user.channels ?? [];
      for (const channel of channels) {
        lines.push(`g, ${user.phone}, ${user.role}, ${channel}`);
      }
      // dm_role: override role for direct messages
      if (user.dm_role) {
        lines.push(`g, ${user.phone}, ${user.dm_role}, direct`);
      }
    }

    // Permission policies (p lines): p, role, domain, intake
    // For each capability set, add policies for all domains that contain users with that role
    const roledomains = new Set<string>();
    for (const user of users) {
      const channels = user.channels ?? [];
      for (const channel of channels) {
        roledomains.add(`${user.role}|${channel}`);
      }
      if (user.dm_role) {
        roledomains.add(`${user.dm_role}|direct`);
      }
    }

    for (const rd of roledomains) {
      const parts = rd.split('|');
      const role = parts[0];
      const domain = parts[1];
      if (!role || !domain) continue;
      // Only add policy if the role has a capability set defined
      if (capSets[role] !== undefined) {
        lines.push(`p, ${role}, ${domain}, intake`);
      }
    }

    const policyText = lines.join('\n');
    log.debug({ policyLines: lines.length }, 'Building Casbin policy');

    this._enforcer = await newEnforcer(this._modelPath, new StringAdapter(policyText));
    log.info(
      { users: users.length, policyLines: lines.length },
      '[policy] Casbin enforcer built'
    );
  }
}
