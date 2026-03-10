/**
 * SignalResponseGateway — sends task results back via Signal.
 *
 * Formatting rules (from spec §7.6):
 *   - Signal message max: 4,096 chars
 *   - Truncate at 3,800 chars: append '[truncated — full output saved]'
 *   - Group replies quote the original message (if quote timestamp provided)
 *   - Error responses: plain text, no stack traces, no internal paths
 */

import { SignalCli } from 'signal-sdk';
import { ChannelIdentity } from '../../types/channel.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('signal-gateway');

const MAX_RESPONSE_CHARS = 3800;
const TRUNCATE_SUFFIX = '\n[truncated — full output saved]';

export interface SendOptions {
  /** Original message timestamp for quoting (group replies) */
  quoteTimestamp?: number;
  /** Author phone for the quoted message */
  quoteAuthor?: string;
}

export class SignalResponseGateway {
  private readonly _cli: SignalCli;

  constructor(cli: SignalCli) {
    this._cli = cli;
  }

  /**
   * Send a response to a recipient/group.
   *
   * @param to - The sender's ChannelIdentity (for direct replies)
   * @param channelId - "direct" or "group:uuid"
   * @param content - The response text
   * @param options - Optional quoting for group context
   */
  async send(
    to: ChannelIdentity,
    channelId: string,
    content: string,
    options?: SendOptions,
  ): Promise<void> {
    const formatted = this._formatResponse(content);

    // Determine recipient: group or direct
    // Strip synthetic prefixes: "group:" → bare group ID, "uuid:" → bare UUID
    // signal-cli accepts phone numbers (+E.164) or bare UUIDs as recipients
    let recipient: string;
    if (channelId.startsWith('group:')) {
      recipient = channelId.slice('group:'.length);
    } else if (to.signalUuid) {
      // Prefer UUID for reply — works even when sender didn't share phone number
      recipient = to.signalUuid;
    } else {
      // Strip uuid: prefix if phone field contains synthetic UUID identifier
      recipient = to.phoneNumber.startsWith('uuid:')
        ? to.phoneNumber.slice('uuid:'.length)
        : to.phoneNumber;
    }

    const sendOptions: Record<string, unknown> = {};

    // Group replies: quote the original message for context
    if (channelId.startsWith('group:') && options?.quoteTimestamp && options?.quoteAuthor) {
      sendOptions['quote'] = {
        timestamp: options.quoteTimestamp,
        author: options.quoteAuthor,
        text: '',
      };
    }

    try {
      await this._cli.sendMessage(recipient, formatted, sendOptions as Parameters<SignalCli['sendMessage']>[2]);
      log.info(
        { recipient: channelId.startsWith('group:') ? channelId : to.phoneNumber, chars: formatted.length },
        '[signal] Response sent'
      );
    } catch (err) {
      log.error({ err, channelId }, '[signal] Failed to send response');
      throw err;
    }
  }

  /** Truncate content to Signal's effective limit and append suffix if needed. */
  private _formatResponse(content: string): string {
    if (content.length <= MAX_RESPONSE_CHARS) return content;
    return content.slice(0, MAX_RESPONSE_CHARS) + TRUNCATE_SUFFIX;
  }
}
