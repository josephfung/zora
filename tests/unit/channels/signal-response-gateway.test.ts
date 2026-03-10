/**
 * Unit tests for SignalResponseGateway
 *
 * Verifies truncation, group quoting, direct replies, and error propagation.
 * Uses a mock SignalCli — no real signal-cli process required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalResponseGateway } from '../../../src/channels/signal/signal-response-gateway.js';
import type { ChannelIdentity } from '../../../src/types/channel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeMockCli() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

const alice: ChannelIdentity = {
  type: 'signal',
  phoneNumber: '+14155551234',
  isLinkedDevice: false,
};

// ---------------------------------------------------------------------------
// Formatting: truncation
// ---------------------------------------------------------------------------
describe('SignalResponseGateway — truncation', () => {
  let cli: ReturnType<typeof makeMockCli>;
  let gw: SignalResponseGateway;

  beforeEach(() => {
    cli = makeMockCli();
    // Cast: gateway only uses sendMessage from the cli object
    gw = new SignalResponseGateway(cli as never);
  });

  it('sends short content unchanged', async () => {
    await gw.send(alice, 'direct', 'Hello!');
    expect(cli.sendMessage).toHaveBeenCalledWith(
      alice.phoneNumber,
      'Hello!',
      {},
    );
  });

  it('sends content exactly at 3800 chars unchanged', async () => {
    const content = 'x'.repeat(3800);
    await gw.send(alice, 'direct', content);
    const [, sent] = cli.sendMessage.mock.calls[0] as [unknown, string, unknown];
    expect(sent.length).toBe(3800);
    expect(sent).not.toContain('[truncated');
  });

  it('truncates content over 3800 chars and appends suffix', async () => {
    const content = 'x'.repeat(4000);
    await gw.send(alice, 'direct', content);
    const [, sent] = cli.sendMessage.mock.calls[0] as [unknown, string, unknown];
    expect(sent).toContain('[truncated — full output saved]');
    expect(sent.length).toBeLessThan(4000);
    // First 3800 chars must be preserved exactly
    expect(sent.startsWith('x'.repeat(3800))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Routing: direct vs group
// ---------------------------------------------------------------------------
describe('SignalResponseGateway — routing', () => {
  let cli: ReturnType<typeof makeMockCli>;
  let gw: SignalResponseGateway;

  beforeEach(() => {
    cli = makeMockCli();
    gw = new SignalResponseGateway(cli as never);
  });

  it('sends direct messages to the phone number', async () => {
    await gw.send(alice, 'direct', 'hi');
    const [recipient] = cli.sendMessage.mock.calls[0] as [string, ...unknown[]];
    expect(recipient).toBe(alice.phoneNumber);
  });

  it('sends group messages to the raw group ID (no "group:" prefix)', async () => {
    await gw.send(alice, 'group:grp-abc-123', 'group reply');
    const [recipient] = cli.sendMessage.mock.calls[0] as [string, ...unknown[]];
    expect(recipient).toBe('grp-abc-123');
  });

  it('does not include quote options for direct messages', async () => {
    await gw.send(alice, 'direct', 'hi', { quoteTimestamp: 123, quoteAuthor: '+1999' });
    const [, , opts] = cli.sendMessage.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(opts).toEqual({});
  });

  it('includes quote for group messages when timestamp+author provided', async () => {
    await gw.send(alice, 'group:grp-xyz', 'reply', {
      quoteTimestamp: 1700000000000,
      quoteAuthor: '+14155551234',
    });
    const [, , opts] = cli.sendMessage.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(opts).toHaveProperty('quote');
    const quote = opts['quote'] as Record<string, unknown>;
    expect(quote['timestamp']).toBe(1700000000000);
    expect(quote['author']).toBe('+14155551234');
  });

  it('omits quote for group messages when only timestamp provided (no author)', async () => {
    await gw.send(alice, 'group:grp-xyz', 'reply', { quoteTimestamp: 1700000000000 });
    const [, , opts] = cli.sendMessage.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(opts).toEqual({});
  });

  it('omits quote for group messages when only author provided (no timestamp)', async () => {
    await gw.send(alice, 'group:grp-xyz', 'reply', { quoteAuthor: '+14155551234' });
    const [, , opts] = cli.sendMessage.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(opts).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------
describe('SignalResponseGateway — error propagation', () => {
  it('rethrows errors from sendMessage', async () => {
    const cli = makeMockCli();
    cli.sendMessage.mockRejectedValue(new Error('network failure'));
    const gw = new SignalResponseGateway(cli as never);

    await expect(gw.send(alice, 'direct', 'hi')).rejects.toThrow('network failure');
  });
});
