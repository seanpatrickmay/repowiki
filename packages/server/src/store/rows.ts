import type { z } from "zod";

export class StoreError extends Error {}

/** A stored body parsed with its Contract schema; a body that fails is corruption, not input. */
export function parsedBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new StoreError(`stored ${what} is invalid`);
  return parsed.data;
}

export const asJson = (value: unknown) => JSON.stringify(value);
