import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { z } from "zod";
import { schemas } from "@agent-as-a-service/contract";
import type { createProjectInput } from "../../../packages/contract/src/v1/projects.js";

type Project = z.infer<typeof schemas.project>;
type Input = z.infer<typeof createProjectInput>;
type Entry = Project & { provisioningKind: "empty" | "clone" | "existing" };
export class ProjectError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Projects {
  private entries: Entry[] = [];
  private mutation = Promise.resolve();
  constructor(
    readonly root: string,
    readonly global: string,
    private readonly registry: string = join(root, "registry.json"),
  ) {}

  async initialize() {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.global, { recursive: true });
    try {
      const data: unknown = JSON.parse(await readFile(this.registry, "utf8"));
      if (
        !Array.isArray(data) ||
        data.some((entry) => !schemas.project.safeParse(entry).success)
      )
        throw new Error("Invalid project registry");
      this.entries = data as Entry[];
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    }
  }

  private isMissing(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    );
  }

  private async save(entries: Entry[]) {
    const temp = `${this.registry}.${randomUUID()}`;
    try {
      await writeFile(temp, JSON.stringify(entries), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temp, this.registry);
    } finally {
      await rm(temp, { force: true });
    }
    this.entries = entries;
  }

  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work);
    this.mutation = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  list() {
    return this.entries.map(
      ({ provisioningKind: _kind, ...project }) => project,
    );
  }
  get(id: string) {
    return this.list().find((entry) => entry.id === id);
  }

  async cwd(id?: string) {
    if (!id) return realpath(this.global);
    const entry = this.entries.find((item) => item.id === id);
    if (!entry)
      throw new ProjectError(404, "not_found", "Project was not found");
    try {
      const root = await realpath(this.root);
      const path = await realpath(entry.localPath!);
      const inside = relative(root, path);
      if (
        !inside ||
        inside === ".." ||
        inside.startsWith(`..${sep}`) ||
        inside.startsWith(sep)
      )
        throw new Error("Outside project root");
      if (!(await stat(path)).isDirectory()) throw new Error("Not a directory");
      return path;
    } catch {
      throw new ProjectError(
        503,
        "project_unavailable",
        "Project directory is unavailable",
      );
    }
  }

  private async clone(url: string, destination: string) {
    if (
      !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/.test(
        url,
      )
    )
      throw new ProjectError(
        400,
        "invalid_repository",
        "Only public HTTPS GitHub repositories are supported",
      );
    if (url.includes("..") || url.includes("@"))
      throw new ProjectError(
        400,
        "invalid_repository",
        "Invalid public repository path",
      );
    await new Promise<void>((done, fail) => {
      const child = spawn(
        "git",
        ["clone", "--depth", "1", "--", url, destination],
        { stdio: "ignore" },
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 60_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (timedOut)
          return fail(
            new ProjectError(503, "clone_failed", "Repository clone timed out"),
          );
        if (code === 0) done();
        else
          fail(
            new ProjectError(503, "clone_failed", "Repository clone failed"),
          );
      });
    });
  }

  async create(input: Input): Promise<Project> {
    const kind =
      input.provisioning?.kind ??
      (input.localPath ? "existing" : input.repositoryUrl ? "clone" : "empty");
    const id = randomUUID();
    const folder = input.folderName ?? id;
    const destination = join(this.root, folder);
    const path =
      kind === "existing"
        ? input.provisioning?.kind === "existing"
          ? input.provisioning.localPath
          : input.localPath!
        : destination;
    const url =
      input.provisioning?.kind === "clone"
        ? input.provisioning.repositoryUrl
        : input.repositoryUrl;
    let temporary: string | undefined;
    let managed = false;
    try {
      if (kind === "existing") {
        const root = await realpath(this.root);
        const actual = await realpath(path).catch(() => {
          throw new ProjectError(
            404,
            "not_found",
            "Existing directory was not found",
          );
        });
        const inside = relative(root, actual);
        if (
          !inside ||
          inside === ".." ||
          inside.startsWith(`..${sep}`) ||
          inside.startsWith(sep) ||
          !(await stat(actual)).isDirectory()
        )
          throw new ProjectError(
            400,
            "invalid_path",
            "Existing directory must be inside the project root",
          );
      } else {
        const root = await realpath(this.root);
        if (
          resolve(root, folder) !== destination ||
          (await lstat(destination).then(
            () => true,
            (error: unknown) => {
              if (this.isMissing(error)) return false;
              throw error;
            },
          ))
        )
          throw new ProjectError(
            409,
            "folder_occupied",
            "Project folder is occupied",
          );
      }
      const actual = kind === "existing" ? await realpath(path) : destination;
      if (this.entries.some((entry) => entry.localPath === actual))
        throw new ProjectError(
          409,
          "duplicate_project",
          "Directory is already registered",
        );
      if (kind === "empty") {
        await mkdir(destination);
        managed = true;
      }
      if (kind === "clone") {
        temporary = join(this.root, `.clone-${id}`);
        await this.clone(url!, temporary);
        await rename(temporary, destination);
        temporary = undefined;
        managed = true;
      }
      const entry: Entry = {
        id,
        name: input.name ?? folder,
        localPath: actual,
        ...(url ? { repositoryUrl: url } : {}),
        createdAt: new Date().toISOString(),
        provisioningKind: kind,
      };
      await this.save([...this.entries, entry]);
      const { provisioningKind: _kind, ...project } = entry;
      return project;
    } catch (error) {
      if (managed) await rm(destination, { recursive: true, force: true });
      if (temporary) await rm(temporary, { recursive: true, force: true });
      if (error instanceof ProjectError) throw error;
      throw new ProjectError(
        503,
        "project_failed",
        "Project could not be created",
      );
    }
  }

  async rename(id: string, name: string) {
    const entry = this.entries.find((project) => project.id === id);
    if (!entry)
      throw new ProjectError(404, "not_found", "Project was not found");
    await this.save(
      this.entries.map((item) => (item.id === id ? { ...item, name } : item)),
    );
    return this.get(id)!;
  }

  async remove(id: string) {
    if (!this.get(id))
      throw new ProjectError(404, "not_found", "Project was not found");
    await this.save(this.entries.filter((entry) => entry.id !== id));
  }
}
