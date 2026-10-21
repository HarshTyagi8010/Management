import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { MailConfig } from '../config.js';
import { AppError } from '../errors.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly enabled: boolean;
  send(message: MailMessage): Promise<void>;
}

/** Captures messages in memory (tests). */
export class MemoryMailer implements Mailer {
  readonly enabled = true;
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage) {
    this.sent.push(message);
  }
}

/**
 * Development only: writes each message as JSON under PROJECT_ROOT/.artifacts/mail
 * (git-ignored). Messages contain single-use links, so config refuses this in production.
 */
export class FileMailer implements Mailer {
  readonly enabled = true;
  constructor(private readonly dir: string) {}
  async send(message: MailMessage) {
    await mkdir(this.dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`;
    await writeFile(path.join(this.dir, name), JSON.stringify(message, null, 2), { encoding: 'utf8', flag: 'wx' });
  }
}

/** No provider configured: features that must email (invitations, password reset) report that clearly. */
export const disabledMailer: Mailer = {
  enabled: false,
  async send() {
    throw new AppError('BUSINESS_RULE', 'Email delivery is not configured for this installation');
  },
};

export function createMailer(config: MailConfig): Mailer {
  return config.transport === 'file' ? new FileMailer(config.dir) : disabledMailer;
}
