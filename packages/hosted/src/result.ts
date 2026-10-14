import type { RefusalCode } from "./refusals.ts";

export interface Ok<T> {
  ok: true;
  value: T;
}

/** A rule said no: one of the spec's refusal codes (§11), with the field or reason when useful. */
export interface Refused {
  ok: false;
  code: RefusalCode;
  detail?: string;
}

/** What every hosted rule returns: the new value, or the refusal the caller shows the author. */
export type Result<T> = Ok<T> | Refused;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function refused(code: RefusalCode, detail?: string): Refused {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}
