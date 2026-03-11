import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramAdapter } from '../../../src/channels/telegram/telegram-adapter.js';
import type { ChannelIdentity, ChannelMessage } from '../../../src/types/channel.js';

const { mockRawAdapter } = vi.hoisted(() => ({
  mockRawAdapter: {
    startPolling: vi.fn().mockResolvedValue(undefined),
    stopPolling: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

// Capture the onNewMessage handler registered by the adapter
let capturedOnNewMessage: ((thread: any, message: any) => Promise<void>) | null = null;

vi.mock('@chat-adapter/telegram', () => ({
  createTelegramAdapter: vi.fn().mockReturnValue(mockRawAdapter),
}));

vi.mock('chat', () => ({
  Chat: vi.fn().mockImplementation(() => ({
    onNewMessage: vi.fn().mockImplementation((_pattern: RegExp, handler: any) => {
      capturedOnNewMessage = handler;
    }),
  })),
}));

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnNewMessage = null;
    adapter = new TelegramAdapter('fake-token');
  });

  it('initializes and starts polling', async () => {
    await adapter.start();
    expect(mockRawAdapter.startPolling).toHaveBeenCalled();
  });

  it('maps incoming Chat SDK events to ChannelMessage', async () => {
    await adapter.start();
    expect(capturedOnNewMessage).toBeDefined();

    let received: ChannelMessage | undefined;
    adapter.onMessage(async (msg) => { received = msg; });

    const mockThread = { isDM: true, id: 'thread-123' };
    const mockMessage = {
      id: 'msg-456',
      threadId: 'thread-123',
      text: 'hello telegram',
      author: { userId: 'user-789', fullName: 'Test User' },
    };

    await capturedOnNewMessage!(mockThread, mockMessage);

    expect(received).toBeDefined();
    expect(received?.id).toBe('msg-456');
    expect(received?.from.phoneNumber).toBe('user-789');
    expect(received?.from.displayName).toBe('Test User');
    expect(received?.content).toBe('hello telegram');
    expect(received?.channelId).toBe('direct');
    expect(received?.channelType).toBe('direct');
  });

  it('sends a response back via postMessage (DM)', async () => {
    await adapter.start();
    const to: ChannelIdentity = {
      type: 'telegram',
      phoneNumber: 'user-789',
      isLinkedDevice: false,
    };

    await adapter.send(to, 'direct', 'hi there');

    expect(mockRawAdapter.postMessage).toHaveBeenCalledWith(
      'user-789',
      expect.objectContaining({ markdown: 'hi there' })
    );
  });

  it('sends to group channel ID when not a DM', async () => {
    await adapter.start();
    const to: ChannelIdentity = {
      type: 'telegram',
      phoneNumber: 'user-789',
      isLinkedDevice: false,
    };

    await adapter.send(to, '-100123456789', 'group message');

    expect(mockRawAdapter.postMessage).toHaveBeenCalledWith(
      '-100123456789',
      expect.objectContaining({ markdown: 'group message' })
    );
  });

  it('stops polling on stop()', async () => {
    await adapter.start();
    await adapter.stop();
    expect(mockRawAdapter.stopPolling).toHaveBeenCalled();
  });
});
