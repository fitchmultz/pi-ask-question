/** Shared runtime guards for the cooperative answer-bus protocol. */

/** Narrow an unknown value to a string-keyed record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Check for a non-blank identifier string of at most 128 characters. */
export function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

/** Narrow an unknown value to a dense array of strings. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && Array.from(value).every((entry) => typeof entry === "string");
}
