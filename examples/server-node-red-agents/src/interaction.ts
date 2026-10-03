import { z } from "zod";

// Validate the private transport envelope; the node remains the decision oracle.
export const plan = z
  .object({
    version: z.literal(1),
    interactionId: z.string().min(1),
    nodeId: z.string().min(1),
    nodeName: z.string(),
    prompt: z.string().min(1),
    decisions: z
      .array(z.object({ id: z.string().min(1), label: z.string() }))
      .min(1),
  })
  .strict();
export type Plan = z.infer<typeof plan>;
export type Checkpoint = { plan: Plan; msg: Record<string, unknown> };
export type Resume = Checkpoint & {
  response: { decision: string; text?: string };
};

export function serializable(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (Array.isArray(value) && Object.keys(value).length !== value.length)
    return false;
  if (
    Array.isArray(value) &&
    Array.from({ length: value.length }, (_, index) => index).some(
      (index) => !Object.hasOwn(value, index),
    )
  )
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== null &&
    Object.getPrototypeOf(prototype) !== null
  )
    return false;
  if (
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) !== "[object Object]"
  )
    return false;
  seen.add(value);
  const valid = Reflect.ownKeys(value).every((key) => {
    if (Array.isArray(value) && key === "length") return true;
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return (
      descriptor.enumerable &&
      "value" in descriptor &&
      serializable(descriptor.value, seen)
    );
  });
  seen.delete(value);
  return valid;
}
