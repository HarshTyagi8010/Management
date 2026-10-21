import { z } from 'zod';

type Shape = Record<string, z.ZodType>;
export type PatchShape<S extends Shape> = { [K in keyof S]: S[K] extends z.ZodDefault<infer I extends z.ZodType> ? z.ZodOptional<I> : z.ZodOptional<S[K]> };

/**
 * Shape for PATCH bodies: every field optional and without its default.
 * Zod applies a field's `.default()` even inside `.partial()`, so a plain
 * `.partial()` would silently reset every omitted field to its default.
 */
export function patchShape<S extends Shape>(shape: S): PatchShape<S> {
  return Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, z.optional(schema instanceof z.ZodDefault ? (schema.unwrap() as z.ZodType) : schema)])) as PatchShape<S>;
}
