/**
 * TelegramAdapter — Telegram implementation of IChannelAdapter.
 *
 * Uses the Vercel Chat SDK (@chat-adapter/telegram) for cross-platform messaging.
 * Wraps the Chat SDK's bot-oriented API into Zora's IChannelAdapter interface.
 */

import { Chat, type Adapter } from 'chat';
import { createTelegramAdapter, TelegramAdapter as ChatTelegramAdapter } from '@chat-adapter/telegram';
import type { ChannelIdentity, ChannelMessage } from '../../types/channel.js';
import type { IChannelAdapter, SendOptions } from '../channel-adapter.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('telegram-adapter');

export class TelegramAdapter implements IChannelAdapter {
  readonly name = 'telegram';
  private readonly _botToken: string;
  private _bot: Chat<Record<string, Adapter>> | null = null;
  private _rawAdapter: ChatTelegramAdapter | null = null;
  private _messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;

  constructor(botToken: string) {
    this._botToken = botToken;
  }

  async start(): Promise<void> {
    log.info('Starting Telegram adapter');

    this._rawAdapter = createTelegramAdapter({
      botToken: this._botToken,
      mode: 'polling',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._bot = new Chat({ adapters: { telegram: this._rawAdapter } } as any);

    // Register handler for all new messages (pattern matches any text)
    this._bot.onNewMessage(/[\s\S]*/u, async (thread, message) => {
      if (!this._messageHandler) return;

      const msg: ChannelMessage = {
        id: message.id,
        from: {
          type: 'telegram',
          phoneNumber: message.author.userId ?? message.threadId,
          displayName: message.author.fullName,
          isLinkedDevice: false,
        },
        channelId: thread.isDM ? 'direct' : thread.id,
        channelType: thread.isDM ? 'direct' : 'group',
        content: message.text,
        timestamp: new Date(),
      };

      await this._messageHandler(msg);
    });

    await this._rawAdapter.startPolling();
    log.info('Telegram adapter ready (polling)');
  }

  async stop(): Promise<void> {
    if (this._rawAdapter) {
      await this._rawAdapter.stopPolling();
      this._rawAdapter = null;
    }
    this._bot = null;
    log.info('Telegram adapter stopped');
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this._messageHandler = handler;
  }

  async send(
    to: ChannelIdentity,
    channelId: string,
    content: string,
    options?: SendOptions
  ): Promise<void> {
    if (!this._rawAdapter) {
      throw new Error('TelegramAdapter: cannot send, adapter not started');
    }

    // threadId for DMs is the Telegram user/chat ID; for groups it's the channelId
    const threadId = channelId === 'direct' ? to.phoneNumber : channelId;

    await this._rawAdapter.postMessage(threadId, {
      markdown: content,
      ...(options?.quoteTimestamp !== undefined && {
        replyTo: String(options.quoteTimestamp),
      }),
    });

    log.info({ threadId, chars: content.length }, 'Telegram response sent');
  }
}
