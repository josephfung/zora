/**
 * CapabilityResolver — maps (senderPhone, channelId) → CapabilitySet.
 *
 * Resolution order:
 *   1. gate.getRole(senderPhone, channelId)
 *   2. If null → return deniedCapability()
 *   3. registry.getCapabilitySet(role, senderPhone, channelId)
 *   4. If undefined → return deniedCapability()
 *
 * Hot-reload: delegates to registry.reload() + gate rebuild.
 *
 * INVARIANT-1: No tool execution without a valid, current CapabilitySet.
 */

import { CapabilitySet, deniedCapability } from '../types/channel.js';
import { ChannelIdentityRegistry } from './channel-identity-registry.js';
import { ChannelPolicyGate } from './channel-policy-gate.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('capability-resolver');

export class CapabilityResolver {
  private readonly _registry: ChannelIdentityRegistry;
  private readonly _gate: ChannelPolicyGate;

  constructor(registry: ChannelIdentityRegistry, gate: ChannelPolicyGate) {
    this._registry = registry;
    this._gate = gate;
  }

  /**
   * Resolves the CapabilitySet for a given (sender, channel) pair.
   * Returns a denied CapabilitySet if the sender is not authorized.
   *
   * INVARIANT-1: Always returns a CapabilitySet — never throws.
   */
  async resolve(senderPhone: string, channelId: string): Promise<CapabilitySet> {
    const role = await this._gate.getRole(senderPhone, channelId);

    if (!role) {
      log.debug({ senderPhone, channelId }, 'No role found — returning denied capability');
      return { ...deniedCapability(), senderPhone, channelId };
    }

    const cap = this._registry.getCapabilitySet(role, senderPhone, channelId);
    if (!cap) {
      log.warn({ senderPhone, channelId, role }, 'Role found but no capability set configured — denying');
      return { ...deniedCapability(), senderPhone, channelId, role };
    }

    log.debug({ senderPhone, channelId, role, tools: cap.allowedTools.length }, 'Capability resolved');
    return cap;
  }

  /**
   * Hot-reload policy from config file.
   * Delegates to registry.reload() — gate rebuilds via onReload callback.
   */
  async reload(): Promise<void> {
    await this._registry.reload();
    // Gate re-builds itself via its onReload callback registered in init()
  }
}
