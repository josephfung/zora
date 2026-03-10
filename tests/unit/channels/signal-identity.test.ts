/**
 * Unit tests for signal-identity.ts
 *
 * Tests E.164 normalization, envelope → ChannelIdentity mapping,
 * channelId extraction, and ChannelMessage construction.
 * No real signal-cli or network required.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeToE164,
  envelopeToChannelIdentity,
  extractChannelId,
  signalEventToChannelMessage,
  MAX_MESSAGE_LENGTH,
} from '../../../src/channels/signal/signal-identity.js';

// ---------------------------------------------------------------------------
// normalizeToE164
// ---------------------------------------------------------------------------
describe('normalizeToE164', () => {
  it('accepts clean E.164 numbers unchanged', () => {
    expect(normalizeToE164('+14155551234')).toBe('+14155551234');
    expect(normalizeToE164('+447911123456')).toBe('+447911123456');
  });

  it('strips whitespace and formatting characters', () => {
    expect(normalizeToE164('+1 (415) 555-1234')).toBe('+14155551234');
    expect(normalizeToE164('+1-415-555-1234')).toBe('+14155551234');
    expect(normalizeToE164('+1.415.555.1234')).toBe('+14155551234');
  });

  it('adds + prefix when missing but number is otherwise valid', () => {
    expect(normalizeToE164('14155551234')).toBe('+14155551234');
  });

  it('throws on numbers that are too short', () => {
    expect(() => normalizeToE164('+123456')).toThrow('E.164');
  });

  it('throws on numbers that are too long', () => {
    expect(() => normalizeToE164('+1234567890123456')).toThrow('E.164');
  });

  it('throws on alphabetic input', () => {
    expect(() => normalizeToE164('not-a-number')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => normalizeToE164('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// envelopeToChannelIdentity
// ---------------------------------------------------------------------------
describe('envelopeToChannelIdentity', () => {
  it('maps a full envelope to ChannelIdentity', () => {
    const id = envelopeToChannelIdentity({
      sourceNumber: '+14155551234',
      sourceUuid: 'abc-uuid',
      sourceName: 'Alice',
    });
    expect(id).toEqual({
      type: 'signal',
      phoneNumber: '+14155551234',
      signalUuid: 'abc-uuid',
      displayName: 'Alice',
      isLinkedDevice: false,
    });
  });

  it('normalizes formatted phone numbers', () => {
    const id = envelopeToChannelIdentity({ sourceNumber: '+1 (415) 555-1234' });
    expect(id.phoneNumber).toBe('+14155551234');
  });

  it('sets optional fields to undefined when absent', () => {
    const id = envelopeToChannelIdentity({ sourceNumber: '+14155551234' });
    expect(id.signalUuid).toBeUndefined();
    expect(id.displayName).toBeUndefined();
  });

  it('throws when sourceNumber is missing', () => {
    expect(() => envelopeToChannelIdentity({})).toThrow('sourceNumber');
  });

  it('always marks incoming messages as non-linked-device', () => {
    const id = envelopeToChannelIdentity({ sourceNumber: '+14155551234' });
    expect(id.isLinkedDevice).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractChannelId
// ---------------------------------------------------------------------------
describe('extractChannelId', () => {
  it('returns direct channel when no groupInfo', () => {
    const result = extractChannelId({});
    expect(result).toEqual({ channelId: 'direct', channelType: 'direct' });
  });

  it('returns direct channel when dataMessage has no groupInfo', () => {
    const result = extractChannelId({ dataMessage: { message: 'hi' } });
    expect(result).toEqual({ channelId: 'direct', channelType: 'direct' });
  });

  it('returns group channel with prefixed groupId', () => {
    const result = extractChannelId({
      dataMessage: { groupInfo: { groupId: 'abc123' } },
    });
    expect(result).toEqual({ channelId: 'group:abc123', channelType: 'group' });
  });

  it('treats missing groupId as direct', () => {
    const result = extractChannelId({ dataMessage: { groupInfo: {} } });
    expect(result).toEqual({ channelId: 'direct', channelType: 'direct' });
  });
});

// ---------------------------------------------------------------------------
// signalEventToChannelMessage
// ---------------------------------------------------------------------------
describe('signalEventToChannelMessage', () => {
  const baseEvent = {
    envelope: {
      sourceNumber: '+14155551234',
      timestamp: 1700000000000,
      dataMessage: { message: 'Hello Zora' },
    },
  };

  it('maps a basic direct message', () => {
    const msg = signalEventToChannelMessage(baseEvent);
    expect(msg.id).toBe('1700000000000');
    expect(msg.from.phoneNumber).toBe('+14155551234');
    expect(msg.channelId).toBe('direct');
    expect(msg.channelType).toBe('direct');
    expect(msg.content).toBe('Hello Zora');
    expect(msg.timestamp).toBeInstanceOf(Date);
    expect(msg.timestamp.getTime()).toBe(1700000000000);
    expect(msg.attachments).toBeUndefined();
  });

  it('maps a group message', () => {
    const event = {
      envelope: {
        sourceNumber: '+14155551234',
        timestamp: 1700000000001,
        dataMessage: {
          message: 'Group hello',
          groupInfo: { groupId: 'grp-xyz' },
        },
      },
    };
    const msg = signalEventToChannelMessage(event);
    expect(msg.channelId).toBe('group:grp-xyz');
    expect(msg.channelType).toBe('group');
  });

  it('handles empty message content', () => {
    const event = {
      envelope: {
        sourceNumber: '+14155551234',
        timestamp: 1700000000002,
        dataMessage: { message: '' },
      },
    };
    const msg = signalEventToChannelMessage(event);
    expect(msg.content).toBe('');
  });

  it('handles missing dataMessage (delivery receipt etc.)', () => {
    const event = {
      envelope: {
        sourceNumber: '+14155551234',
        timestamp: 1700000000003,
      },
    };
    const msg = signalEventToChannelMessage(event);
    expect(msg.content).toBe('');
    expect(msg.attachments).toBeUndefined();
  });

  it('includes attachments when present', () => {
    const event = {
      envelope: {
        sourceNumber: '+14155551234',
        timestamp: 1700000000004,
        dataMessage: {
          message: 'See attached',
          attachments: [
            { id: 'att-1', filename: 'photo.jpg' },
            { id: 'att-2' },
          ],
        },
      },
    };
    const msg = signalEventToChannelMessage(event);
    expect(msg.attachments).toEqual(['photo.jpg', 'att-2']);
  });

  it('throws (DoS protection) when content exceeds MAX_MESSAGE_LENGTH', () => {
    const event = {
      envelope: {
        sourceNumber: '+14155551234',
        timestamp: 1700000000005,
        dataMessage: { message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
      },
    };
    expect(() => signalEventToChannelMessage(event)).toThrow(/exceeds max length/);
  });

  it('accepts content exactly at MAX_MESSAGE_LENGTH', () => {
    const event = {
      envelope: {
        sourceNumber: '+14155551234',
        timestamp: 1700000000006,
        dataMessage: { message: 'x'.repeat(MAX_MESSAGE_LENGTH) },
      },
    };
    expect(() => signalEventToChannelMessage(event)).not.toThrow();
  });

  it('falls back to Date.now() when envelope has no timestamp', () => {
    const before = Date.now();
    const event = {
      envelope: {
        sourceNumber: '+14155551234',
        dataMessage: { message: 'no timestamp' },
      },
    };
    const msg = signalEventToChannelMessage(event);
    const after = Date.now();
    expect(msg.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp.getTime()).toBeLessThanOrEqual(after);
    // id and timestamp must be consistent
    expect(msg.id).toBe(String(msg.timestamp.getTime()));
  });
});
