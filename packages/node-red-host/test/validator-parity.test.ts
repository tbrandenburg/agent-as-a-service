import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { schemas } from "../../contract/src/index.js";

const require = createRequire(`${process.cwd()}/package.json`);
const packaged = require(
  resolve(process.cwd(), "packages/node-red-host/lib/run-output.cjs"),
) as {
  runInput: {
    parse(value: unknown): unknown;
    safeParse(value: unknown): { success: boolean };
  };
  runOutput: {
    parse(value: unknown): unknown;
    safeParse(value: unknown): { success: boolean };
  };
};

describe("packaged run validator parity", () => {
  it.each([
    "",
    "text",
    13.75,
    false,
    null,
    {},
    [],
    [1, true, null, { nested: ["x", 2.5] }],
  ])("preserves source JSON value %j for input and output", (value) => {
    for (const name of ["runInput", "runOutput"] as const) {
      const source = schemas[name].parse(value);
      const result = packaged[name].parse(value);
      expect(result).toEqual(source);
      expect(JSON.stringify(result)).toBe(JSON.stringify(source));
    }
  });

  it("rejects source invalid values and accepts VM-realm JSON objects", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse: unknown[] = [];
    sparse.length = 1;
    const invalid: unknown[] = [
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
    ];

    for (const value of invalid) {
      for (const name of ["runInput", "runOutput"] as const) {
        expect(packaged[name].safeParse(value).success).toBe(
          schemas[name].safeParse(value).success,
        );
        expect(packaged[name].safeParse(value).success).toBe(false);
      }
    }

    const vmValue: unknown = runInNewContext(
      "({nested:[1,true,null,{result:-110}]})",
    );
    for (const name of ["runInput", "runOutput"] as const) {
      const source = schemas[name].parse(vmValue);
      const result = packaged[name].parse(vmValue);
      expect(result).toEqual(source);
      expect(JSON.stringify(result)).toBe(JSON.stringify(source));
    }
  });
});
