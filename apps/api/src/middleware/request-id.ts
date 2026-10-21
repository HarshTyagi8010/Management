import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const INBOUND_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Accept a well-formed inbound X-Request-Id (e.g. from the load balancer), otherwise generate one. */
export function resolveRequestId(req: IncomingMessage): string {
  const inbound = req.headers['x-request-id'];
  if (typeof inbound === 'string' && INBOUND_ID.test(inbound)) return inbound;
  return randomUUID();
}
