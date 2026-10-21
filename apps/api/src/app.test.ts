import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, healthResponseSchema, readinessResponseSchema } from '@bizmgmt/contracts';
import { buildTestApp } from './test-utils.js';

describe('health and readiness', () => {
  it('GET /api/v1/health returns the health contract', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/health').expect(200);
    expect(healthResponseSchema.parse(res.body).status).toBe('ok');
  });

  it('GET /api/v1/ready reports skipped database when none is configured', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/ready').expect(200);
    expect(readinessResponseSchema.parse(res.body).checks).toEqual({ database: 'skipped' });
  });

  it('GET /api/v1/ready returns 503 NOT_READY when a dependency is down or throws', async () => {
    const { app } = buildTestApp({
      checks: {
        database: async () => {
          throw new Error('connect ECONNREFUSED mongodb://user:pass@10.0.0.5');
        },
      },
    });
    const res = await request(app).get('/api/v1/ready').expect(503);
    const body = errorEnvelopeSchema.parse(res.body);
    expect(body.error.code).toBe('NOT_READY');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });
});

describe('error envelope', () => {
  it('unknown routes return 404 NOT_FOUND with a request id', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/nope').expect(404);
    const body = errorEnvelopeSchema.parse(res.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('malformed JSON returns 400 MALFORMED_JSON', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"a":')
      .expect(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });

  it('non-JSON bodies return 415', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/v1/health').set('Content-Type', 'text/plain').send('hello').expect(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('oversized bodies return 413', async () => {
    const { app } = buildTestApp({ env: { BODY_LIMIT: '1kb' } });
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(4096) }))
      .expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('unexpected errors return a generic 500 without internal details, and are logged', async () => {
    const boom = Router();
    boom.get('/boom', () => {
      throw new Error('E11000 duplicate key error collection: bizmgmt.salesInvoices');
    });
    const { app, logs } = buildTestApp({ routers: [boom] });
    const res = await request(app).get('/api/v1/boom').expect(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('E11000');
    expect(logs()).toContain('E11000');
  });
});

describe('request ids', () => {
  it('echoes a well-formed inbound X-Request-Id', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'lb-req-12345678');
    expect(res.headers['x-request-id']).toBe('lb-req-12345678');
  });

  it('replaces a malformed inbound X-Request-Id', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad id <script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('security headers and CORS', () => {
  it('sets restrictive headers and hides the framework', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('allows configured origins with credentials', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173').expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects other origins', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example').expect(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('logging', () => {
  it('never logs cookies, authorization headers or query strings', async () => {
    const { app, logs } = buildTestApp();
    await request(app)
      .get('/api/v1/health?email=someone@example.com')
      .set('Cookie', '__Host-sid=supersecretsessiontoken')
      .set('Authorization', 'Bearer abc.def.ghi');
    const output = logs();
    expect(output).toContain('/api/v1/health');
    expect(output).not.toContain('supersecretsessiontoken');
    expect(output).not.toContain('abc.def.ghi');
    expect(output).not.toContain('someone@example.com');
  });
});
