import { z } from 'zod';
export { legalEntitySchema, unitSchema } from '@bizmgmt/contracts';

/** Cursor-paged list envelope (docs/api/api-conventions.md "Lists"). */
export const pageSchemaOf = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), page: z.object({ nextCursor: z.string().nullable(), limit: z.number() }) });
