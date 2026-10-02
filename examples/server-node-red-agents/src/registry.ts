import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, rm } from "node:fs/promises";
import { schemas } from "@agent-as-a-service/contract";
import { validate, type Registry } from "./native.js";

export interface Store {
  load(): Promise<Registry>;
  save(registry: Registry): Promise<void>;
}

export class JsonStore implements Store {
  constructor(private readonly path: string) {}
  async load(): Promise<Registry> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (typeof data !== "object" || data === null || Array.isArray(data))
        throw new Error("Invalid workflow registry");
      for (const [id, value] of Object.entries(data)) {
        const definition = schemas.definition.parse(value);
        if (definition.id !== id || validate(definition).length)
          throw new Error("Invalid workflow registry definition");
      }
      return data as Registry;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return {};
      throw error;
    }
  }
  async save(registry: Registry): Promise<void> {
    const temp = `${this.path}.${randomUUID()}`;
    try {
      await writeFile(temp, JSON.stringify(registry), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
