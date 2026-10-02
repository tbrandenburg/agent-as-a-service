import { describe, expect, it } from "vitest";
import { schemas } from "./index.js";
import { runInNewContext } from "node:vm";

describe("JSON run transport", () => {
  it.each([
    "",
    "text",
    13.75,
    false,
    null,
    {},
    [],
    [1, true, null, { nested: ["x", 2.5] }],
  ])("preserves %j", (value) => {
    expect(schemas.runInput.parse(value)).toEqual(value);
    expect(schemas.runOutput.parse(value)).toEqual(value);
  });
  it("rejects non-JSON values without coercion or recursive overflow", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse: unknown[] = [];
    sparse.length = 1;
    for (const value of [
      undefined,
      () => {},
      Symbol("x"),
      1n,
      NaN,
      Infinity,
      Buffer.from("x"),
      new Date(),
      new Map(),
      cycle,
      { nested: undefined },
      [undefined],
      sparse,
    ]) {
      expect(schemas.runInput.safeParse(value).success).toBe(false);
      expect(schemas.runOutput.safeParse(value).success).toBe(false);
    }
  });
  it("accepts plain JSON objects returned by a Node-RED Function VM", () => {
    const value: unknown = runInNewContext(
      "({nested:[1,true,null,{result:-110}]})",
    );
    expect(schemas.runOutput.parse(value)).toEqual({
      nested: [1, true, null, { result: -110 }],
    });
  });
});
