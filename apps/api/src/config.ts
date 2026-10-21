import path from 'node:path';
import { z } from 'zod';

/** Development/test-only secret. Production refuses to start with it (or without APP_SECRET). */
export const DEV_APP_SECRET = 'insecure-development-secret-do-not-use-in-production';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

const booleanOrHops = z
  .string()
  .default('false')
  .transform((value, ctx) => {
    if (value === 'false') return false as const;
    const hops = Number(value);
    if (!Number.isInteger(hops) || hops < 1 || hops > 5) {
      ctx.addIssue({ code: 'custom', message: 'TRUST_PROXY must be "false" or an integer 1-5' });
      return z.NEVER;
    }
    return hops;
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    // The web app's own origin must be listed: browsers send Origin on same-origin POSTs too.
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
    TRUST_PROXY: booleanOrHops,
    BODY_LIMIT: z
      .string()
      .regex(/^\d{1,4}kb$/, 'BODY_LIMIT must look like "256kb"')
      .default('256kb'),
    MONGODB_URI: z.string().optional(),
    MONGODB_DB_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,38}$/)
      .default('bizmgmt_dev'),
    APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters').optional(),
    PUBLIC_APP_URL: z.url().default('http://localhost:5173'),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(72).default(12),
    SIGNUP_ENABLED: z.enum(['true', 'false']).optional(),
    MFA_ENFORCEMENT: z.enum(['off', 'privileged']).optional(),
    MAIL_TRANSPORT: z.enum(['file', 'disabled']).optional(),
    PASSWORD_HASH_PROFILE: z.enum(['standard', 'test']).default('standard'),
    STORAGE_DRIVER: z.enum(['local', 'disabled']).optional(),
    /** Directory for the local storage driver (default PROJECT_ROOT/.artifacts/storage). */
    STORAGE_DIR: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const issue = (key: string, message: string) => ctx.addIssue({ code: 'custom', path: [key], message });
    if (env.PASSWORD_HASH_PROFILE === 'test' && env.NODE_ENV !== 'test') {
      issue('PASSWORD_HASH_PROFILE', 'the test profile is allowed only when NODE_ENV=test');
    }
    if (env.NODE_ENV !== 'production') return;
    if (!env.MONGODB_URI) issue('MONGODB_URI', 'MONGODB_URI is required in production');
    if (!env.APP_SECRET || env.APP_SECRET === DEV_APP_SECRET) issue('APP_SECRET', 'a unique APP_SECRET is required in production');
    if (!env.PUBLIC_APP_URL.startsWith('https://')) issue('PUBLIC_APP_URL', 'PUBLIC_APP_URL must use https in production');
    if (env.MAIL_TRANSPORT === 'file') issue('MAIL_TRANSPORT', 'the file mail transport is for development only');
    if (env.STORAGE_DRIVER === 'local') issue('STORAGE_DRIVER', 'local storage is for development only (S3 arrives with deployment)');
  });

export type StorageConfig = { driver: 'local'; dir: string } | { driver: 'disabled' };

export type MailConfig = { transport: 'file'; dir: string } | { transport: 'disabled' };

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  host: string;
  port: number;
  corsOrigins: string[];
  trustProxy: false | number;
  bodyLimit: string;
  mongodbUri: string | undefined;
  mongodbDbName: string;
  version: string;
  /** Master secret; purpose-specific keys are derived from it (platform/crypto.ts). */
  appSecret: string;
  usingDevSecret: boolean;
  /** Base URL of the web app, used in links sent by email. */
  publicAppUrl: string;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  signupEnabled: boolean;
  /** "privileged": users must enrol MFA before they can use step-up permissions. */
  mfaEnforcement: 'off' | 'privileged';
  mail: MailConfig;
  passwordHashProfile: 'standard' | 'test';
  /** Where generated documents are stored; shared by the API (downloads) and the worker (rendering). */
  storage: StorageConfig;
}

/** Thrown with a message that never includes configuration values (they may be secrets). */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function parseOrigins(raw: string, production: boolean): string[] {
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new ConfigError('CORS_ORIGINS contains an invalid URL');
    }
    if (url.origin !== origin) throw new ConfigError('CORS_ORIGINS entries must be bare origins (scheme://host[:port])');
    if (production && url.protocol !== 'https:') throw new ConfigError('CORS_ORIGINS must use https in production');
  }
  return origins;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Report variable names and rule messages only, never received values.
    const problems = result.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  const e = result.data;
  const production = e.NODE_ENV === 'production';
  const mailTransport = e.MAIL_TRANSPORT ?? (production ? 'disabled' : 'file');
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    host: e.HOST,
    port: e.PORT,
    corsOrigins: parseOrigins(e.CORS_ORIGINS, production),
    trustProxy: e.TRUST_PROXY,
    bodyLimit: e.BODY_LIMIT,
    mongodbUri: e.MONGODB_URI || undefined,
    mongodbDbName: e.MONGODB_DB_NAME,
    version: env.npm_package_version ?? '0.1.0',
    appSecret: e.APP_SECRET ?? DEV_APP_SECRET,
    usingDevSecret: !e.APP_SECRET || e.APP_SECRET === DEV_APP_SECRET,
    publicAppUrl: e.PUBLIC_APP_URL.replace(/\/+$/, ''),
    sessionIdleMs: e.SESSION_IDLE_MINUTES * 60_000,
    sessionAbsoluteMs: e.SESSION_ABSOLUTE_HOURS * 3_600_000,
    signupEnabled: e.SIGNUP_ENABLED ? e.SIGNUP_ENABLED === 'true' : !production,
    mfaEnforcement: e.MFA_ENFORCEMENT ?? (production ? 'privileged' : 'off'),
    mail: mailTransport === 'file' ? { transport: 'file', dir: path.join(PROJECT_ROOT, '.artifacts', 'mail') } : { transport: 'disabled' },
    passwordHashProfile: e.PASSWORD_HASH_PROFILE,
    storage: (e.STORAGE_DRIVER ?? (production ? 'disabled' : 'local')) === 'local' ? { driver: 'local', dir: path.resolve(e.STORAGE_DIR ?? path.join(PROJECT_ROOT, '.artifacts', 'storage')) } : { driver: 'disabled' },
  };
}
