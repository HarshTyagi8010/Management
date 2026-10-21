import { Writable } from 'node:stream';
import type { Router } from 'express';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import type { ReadinessCheck } from './routes/health.js';

/** Builds an app with an in-memory log sink so tests can assert on what was (not) logged. */
export function buildTestApp(
  options: { checks?: Record<string, ReadinessCheck>; env?: NodeJS.ProcessEnv; routers?: Router[] } = {},
) {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  const config = loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:5173', ...options.env });
  const logger = createLogger({ level: 'info', service: 'api-test', destination: sink });
  const app = createApp({
    config,
    logger,
    readinessChecks: options.checks ?? { database: async () => 'skipped' },
    routers: options.routers ?? [],
  });
  return { app, logs: () => lines.join('') };
}

/** A small, valid PNG (solid grey) for upload and rendering tests. */
export async function tinyPng(width = 16, height = 16): Promise<Buffer> {
  const { crc32, deflateSync } = await import('node:zlib');
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(0, 9); // greyscale
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0x80)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
