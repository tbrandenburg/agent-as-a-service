import { z } from "zod";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Reject runtime values that JSON.stringify would silently change or discard. */
export function isJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  // Native Function nodes create plain objects in a separate VM realm.
  if (
    !Array.isArray(value) &&
    prototype !== null &&
    (typeof prototype !== "object" ||
      Object.getPrototypeOf(prototype) !== null ||
      Object.prototype.toString.call(value) !== "[object Object]")
  )
    return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(
        { length: value.length },
        (_, index) =>
          Object.hasOwn(value, index) && isJsonValue(value[index], ancestors),
      ).every(Boolean)
    : Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

const recursive: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(recursive),
    z.record(recursive),
  ]),
);

export const jsonValue = z.preprocess((value, context) => {
  if (isJsonValue(value)) return value;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Expected a JSON value",
    fatal: true,
  });
  return z.NEVER;
}, recursive);
export const jsonValueSchema = recursive;
