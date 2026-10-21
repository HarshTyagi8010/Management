import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_APP_SECRET, loadConfig } from './config.js';

const PROD = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb+srv://x',
  CORS_ORIGINS: 'https://app.example.in',
  APP_SECRET: 'a-production-secret-that-is-long-enough-1234',
  PUBLIC_APP_URL: 'https://app.example.in',
};

describe('loadConfig', () => {
  it('applies development defaults', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(4000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(config.trustProxy).toBe(false);
    expect(config.mongodbUri).toBeUndefined();
  });

  it('requires MONGODB_URI in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.in' })).toThrow(ConfigError);
  });

  it('requires https CORS origins in production', () => {
    expect(() =>
      loadConfig({ ...PROD, CORS_ORIGINS: 'http://app.example.in' }),
    ).toThrow(/https/);
  });

  it('rejects origins with paths or wildcards', () => {
    expect(() => loadConfig({ CORS_ORIGINS: 'http://localhost:5173/app' })).toThrow(ConfigError);
    expect(() => loadConfig({ CORS_ORIGINS: '*' })).toThrow(ConfigError);
  });

  it('never echoes configuration values in error messages', () => {
    try {
      loadConfig({ PORT: 'not-a-port-s3cr3t', NODE_ENV: 'production', MONGODB_URI: '' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('PORT');
      expect((err as Error).message).not.toContain('s3cr3t');
    }
  });

  it('parses TRUST_PROXY hop counts', () => {
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(() => loadConfig({ TRUST_PROXY: 'true' })).toThrow(ConfigError);
  });

  it('accepts a complete production configuration with safe defaults', () => {
    const config = loadConfig(PROD);
    expect(config.signupEnabled).toBe(false);
    expect(config.mfaEnforcement).toBe('privileged');
    expect(config.mail).toEqual({ transport: 'disabled' });
    expect(config.usingDevSecret).toBe(false);
  });

  it('refuses production without a unique APP_SECRET or with the file mailer', () => {
    expect(() => loadConfig({ ...PROD, APP_SECRET: undefined })).toThrow(/APP_SECRET/);
    expect(() => loadConfig({ ...PROD, APP_SECRET: DEV_APP_SECRET })).toThrow(/APP_SECRET/);
    expect(() => loadConfig({ ...PROD, MAIL_TRANSPORT: 'file' })).toThrow(/MAIL_TRANSPORT/);
    expect(() => loadConfig({ ...PROD, PUBLIC_APP_URL: 'http://app.example.in' })).toThrow(/PUBLIC_APP_URL/);
  });

  it('allows the fast password-hash profile only under NODE_ENV=test', () => {
    expect(loadConfig({ NODE_ENV: 'test', PASSWORD_HASH_PROFILE: 'test' }).passwordHashProfile).toBe('test');
    expect(() => loadConfig({ NODE_ENV: 'development', PASSWORD_HASH_PROFILE: 'test' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...PROD, PASSWORD_HASH_PROFILE: 'test' })).toThrow(ConfigError);
  });

  it('does not echo APP_SECRET when it is too short', () => {
    expect(() => loadConfig({ APP_SECRET: 'tiny-s3cr3t' })).toThrow(/^(?!.*s3cr3t).*APP_SECRET/);
  });
});
