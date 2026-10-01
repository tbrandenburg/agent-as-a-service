import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Registry, Tab } from "./managed.js";
import { markerOf } from "./managed.js";

export interface Admin {
  get(id: string): Promise<Tab | null>;
  create(tab: Tab): Promise<string>;
  update(id: string, tab: Tab): Promise<void>;
  delete(id: string): Promise<void>;
}

export class NodeRedAdmin implements Admin {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async request(
    path: string,
    method = "GET",
    payload?: Tab,
  ): Promise<Response> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok && !(method === "GET" && response.status === 404))
      throw new Error(
        `Node-RED Admin API ${method} failed (${response.status})`,
      );
    return response;
  }

  async get(id: string): Promise<Tab | null> {
    const response = await this.request(`/flow/${encodeURIComponent(id)}`);
    return response.status === 404 ? null : ((await response.json()) as Tab);
  }

  async create(tab: Tab): Promise<string> {
    const response = await this.request("/flow", "POST", tab);
    const result: unknown =
      response.status === 204 ? null : await response.json();
    if (
      typeof result === "object" &&
      result !== null &&
      "id" in result &&
      typeof result.id === "string"
    )
      return result.id;
    const all = await this.request("/flows");
    const flows: unknown = await all.json();
    const nodes = Array.isArray(flows)
      ? flows
      : typeof flows === "object" && flows !== null && "flows" in flows
        ? flows.flows
        : null;
    if (!Array.isArray(nodes)) throw new Error("Invalid Node-RED flow list");
    const matches = nodes.filter(
      (node): node is { id: string } =>
        typeof node === "object" &&
        node !== null &&
        node.type === "tab" &&
        node.info === tab.info &&
        typeof node.id === "string",
    );
    if (matches.length !== 1)
      throw new Error("Cannot resolve created Node-RED tab");
    return matches[0].id;
  }

  async update(id: string, tab: Tab): Promise<void> {
    await this.request(`/flow/${encodeURIComponent(id)}`, "PUT", {
      ...tab,
      id,
    });
  }

  async delete(id: string): Promise<void> {
    await this.request(`/flow/${encodeURIComponent(id)}`, "DELETE");
  }
}

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
    await writeFile(temp, JSON.stringify(registry), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temp, this.path);
  }
}

export async function verified(
  admin: Admin,
  id: string,
  tab: Tab,
): Promise<boolean> {
  const deployed = await admin.get(id);
  if (
    !deployed ||
    markerOf(deployed) !== markerOf(tab) ||
    deployed.label !== tab.label
  )
    return false;
  const normalized = (nodes: Tab["nodes"]) =>
    nodes.map(({ wires, z: _tab, ...node }) => ({
      ...node,
      // Node-RED omits wires on native return nodes in its Admin API response.
      wires:
        node.type === "link out" && node.mode === "return"
          ? (wires ?? [])
          : wires,
    }));
  return (
    JSON.stringify(normalized(deployed.nodes ?? [])) ===
      JSON.stringify(normalized(tab.nodes)) &&
    JSON.stringify(deployed.configs ?? []) === JSON.stringify(tab.configs)
  );
}
