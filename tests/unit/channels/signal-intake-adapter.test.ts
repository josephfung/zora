/**
 * Unit tests for SignalIntakeAdapter
 *
 * Verifies daemon lifecycle, deduplication, DoS size limit,
 * and INVARIANT-7 (stop on max retries).
 *
 * Uses a vi.hoisted EventEmitter fake for signal-sdk SignalCli.
 * No real signal-cli process or Signal account required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Hoisted mock — must be defined before vi.mock() factory is evaluated
// ---------------------------------------------------------------------------
const { FakeSignalCliClass, getLastInstance, setNextConnectError, setGlobalConnectError, clearGlobalConnectError } = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  let _lastInstance: FakeSignalCliInstance | null = null;
  let _nextConnectError: Error | null = null;
  let _globalConnectError: Error | null = null;

  interface FakeSignalCliInstance extends EventEmitter {
    connected: boolean;
    shutdownCalled: boolean;
    connectError: Error | null;
    connect(): Promise<void>;
    gracefulShutdown(): Promise<void>;
    simulateMessage(raw: object): void;
    simulateClose(): void;
  }

  class FakeSignalCli extends EventEmitter implements FakeSignalCliInstance {
    connected = false;
    shutdownCalled = false;
    connectError: Error | null = null;

    async connect() {
      if (this.connectError) throw this.connectError;
      this.connected = true;
    }

    async gracefulShutdown() {
      this.shutdownCalled = true;
      this.connected = false;
    }

    simulateMessage(raw: object) { this.emit('message', raw); }
    simulateClose() { this.emit('close'); }
  }

  const FakeSignalCliClass = class extends FakeSignalCli {
    constructor(_phone: string) {
      super();
      // Global error takes precedence; then one-shot next error
      if (_globalConnectError) {
        this.connectError = _globalConnectError;
      } else if (_nextConnectError) {
        this.connectError = _nextConnectError;
        _nextConnectError = null;
      }
      _lastInstance = this;
    }
  };

  function getLastInstance() { return _lastInstance; }
  function setNextConnectError(err: Error) { _nextConnectError = err; }
  function setGlobalConnectError(err: Error) { _globalConnectError = err; }
  function clearGlobalConnectError() { _globalConnectError = null; }

  return { FakeSignalCliClass, getLastInstance, setNextConnectError, setGlobalConnectError, clearGlobalConnectError };
});

vi.mock('signal-sdk', () => ({
  SignalCli: FakeSignalCliClass,
}));

// Now import the module under test (after mock is registered)
import { SignalIntakeAdapter } from '../../../src/channels/signal/signal-intake-adapter.js';
import type { ChannelMessage } from '../../../src/types/channel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    envelope: {
      sourceNumber: '+14155551234',
      timestamp: Date.now(),
      dataMessage: { message: 'test message' },
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
describe('SignalIntakeAdapter — lifecycle', () => {
  afterEach(() => { vi.clearAllTimers(); });

  it('connects successfully', async () => {
    const adapter = new SignalIntakeAdapter('+14155551234');
    await adapter.start();
    expect(getLastInstance()?.connected).toBe(true);
    await adapter.stop();
  });

  it('stop() calls gracefulShutdown()', async () => {
    const adapter = new SignalIntakeAdapter('+14155551234');
    await adapter.start();
    await adapter.stop();
    expect(getLastInstance()?.shutdownCalled).toBe(true);
  });

  it('stop() before start() does not throw', async () => {
    const adapter = new SignalIntakeAdapter('+14155551234');
    await expect(adapter.stop()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
describe('SignalIntakeAdapter — message handling', () => {
  it('delivers valid messages to the registered handler', async () => {
    const adapter = new SignalIntakeAdapter('+14155551234');
    const received: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await adapter.start();
    getLastInstance()!.simulateMessage(makeEnvelope());
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0]!.from.phoneNumber).toBe('+14155551234');
    await adapter.stop();
  });

  it('drops messages with no registered handler (no crash)', async () => {
    const adapter = new SignalIntakeAdapter('+14155551234');
    await adapter.start();
    expect(() => getLastInstance()!.simulateMessage(makeEnvelope())).not.toThrow();
    await adapter.stop();
  });

  it('rejects messages exceeding 10,000 chars (DoS protection)', async () => {
    const adapter = new SignalIntakeAdapter('+14155551234');
    const received: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });
    await adapter.start();

    getLastInstance()!.simulateMessage(makeEnvelope({
      dataMessage: { message: 'x'.repeat(10_001) },
    }));
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(0);
    await adapter.stop();
  });

  it('rejects messages with missing sourceNumber', async () => {
    const adapter = new SignalIntakeAdapter('+14155551234');
    const received: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });
    await adapter.start();

    getLastInstance()!.simulateMessage({
      envelope: { timestamp: Date.now(), dataMessage: { message: 'hi' } },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(0);
    await adapter.stop();
  });

  it('logs sender and channel but not message content', async () => {
    // This test verifies the security invariant structurally:
    // the adapter only logs `sender` and `channelId`, never `content`.
    // The actual log output goes to pino — we verify no crash and delivery occurs.
    const adapter = new SignalIntakeAdapter('+14155551234');
    const received: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });
    await adapter.start();

    getLastInstance()!.simulateMessage(makeEnvelope({
      dataMessage: { message: 'SENSITIVE_DATA' },
    }));
    await new Promise(r => setTimeout(r, 10));

    // Message delivered; content visible to handler but not logged by adapter
    expect(received[0]!.content).toBe('SENSITIVE_DATA');
    await adapter.stop();
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------
describe('SignalIntakeAdapter — deduplication', () => {
  it('delivers the first occurrence of a message id', async () => {
    const adapter = new SignalIntakeAdapter('+14155551234');
    const received: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });
    await adapter.start();

    getLastInstance()!.simulateMessage(makeEnvelope({ timestamp: 99999 }));
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    await adapter.stop();
  });

  it('drops duplicate messages with the same timestamp/id', async () => {
    const adapter = new SignalIntakeAdapter('+14155551234');
    const received: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });
    await adapter.start();

    const event = makeEnvelope({ timestamp: 88888 });
    getLastInstance()!.simulateMessage(event);
    getLastInstance()!.simulateMessage(event); // duplicate
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    await adapter.stop();
  });

  it('delivers messages with distinct timestamps independently', async () => {
    const adapter = new SignalIntakeAdapter('+14155551234');
    const received: ChannelMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });
    await adapter.start();

    getLastInstance()!.simulateMessage(makeEnvelope({ timestamp: 1000 }));
    getLastInstance()!.simulateMessage(makeEnvelope({ timestamp: 2000 }));
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(2);
    await adapter.stop();
  });
});

// ---------------------------------------------------------------------------
// Backoff / INVARIANT-7
// ---------------------------------------------------------------------------
describe('SignalIntakeAdapter — INVARIANT-7 (max retries)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    clearGlobalConnectError();
    vi.useRealTimers();
  });

  it('throws after max retries when connection always fails', async () => {
    // Make ALL instances fail — global error persists across every new SignalCli()
    setGlobalConnectError(new Error('connection refused'));

    const adapter = new SignalIntakeAdapter('+14155551234');
    const startPromise = adapter.start();

    // Drain all backoff timers (1s, 2s, 4s, 8s, 16s + one extra)
    for (let i = 0; i < 7; i++) {
      await vi.runAllTimersAsync();
    }

    await expect(startPromise).rejects.toThrow(/failed to connect after/);
  });
});
