import { z } from 'zod';

export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  time: z.iso.datetime(),
});

export const dependencyStatusSchema = z.enum(['up', 'down', 'skipped']);

export const readinessResponseSchema = z.strictObject({
  status: z.literal('ready'),
  checks: z.record(z.string(), dependencyStatusSchema),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
