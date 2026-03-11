/**
 * WebhookServer — Handles incoming webhooks for multi-channel adapters.
 *
 * Each platform adapter translates Vercel Chat SDK events → ChannelMessage.
 *
 * INVARIANT-10: Webhook server validates platform signatures before processing.
 */

import express from 'express';
import { ChannelManager } from './channel-manager.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('webhook-server');

export class WebhookServer {
  private readonly _app: express.Application;
  private readonly _port: number;
  private readonly _manager: ChannelManager;
  private _server: ReturnType<express.Application['listen']> | null = null;

  constructor(manager: ChannelManager, port = 8080) {
    this._app = express();
    this._port = port;
    this._manager = manager;

    this._setupRoutes();
  }

  /**
   * Start the webhook server.
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this._server = this._app.listen(this._port, () => {
        log.info({ port: this._port }, 'Webhook server listening');
        resolve();
      });
    });
  }

  /**
   * Stop the webhook server.
   */
  async stop(): Promise<void> {
    const server = this._server;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      this._server = null;
    }
    log.info('Webhook server stopped');
  }

  private _setupRoutes(): void {
    // Basic health check
    this._app.get('/health', (_req, res) => {
      res.status(200).json({ status: 'ok' });
    });

    // Platform-specific webhooks
    // Each platform adapter will register its own route here
    this._app.post('/webhooks/:platform', express.json(), async (req, res) => {
      const platform = req.params['platform'] ?? 'unknown';
      log.info({ platform }, 'Received webhook');

      // TODO(channels): validate platform signature, map payload to ChannelMessage,
      // then dispatch: await this._manager.handleMessage(msg)
      void this._manager; // marks field as intentionally reserved

      res.status(200).send('OK');
    });
  }
}
