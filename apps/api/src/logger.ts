import { pino, type Logger } from 'pino';

/**
 * Paths redacted from every log line. Request/response bodies are never logged
 * by the HTTP logger; this list guards against accidental inclusion elsewhere.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.secret',
  '*.otp',
  '*.mongodbUri',
  'password',
  'token',
  'secret',
];

export function createLogger(options: { level: string; service: string; destination?: pino.DestinationStream }): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      formatters: { level: (label) => ({ level: label }) },
    },
    options.destination,
  );
}
