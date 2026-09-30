import { initContract } from "@ts-rest/core";
import { z } from "zod";
import * as c from "./schemas/common.js";
import * as d from "./schemas/domain.js";

const t = initContract();
const path = c.pathProject;
const folderName = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
  .refine((name) => name !== "." && name !== "..");
const provisioning = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }).strict(),
  z
    .object({ kind: z.literal("clone"), repositoryUrl: z.string().url() })
    .strict(),
  z
    .object({ kind: z.literal("existing"), localPath: z.string().min(1) })
    .strict(),
]);
export const createProjectInput = z
  .object({
    name: z.string().min(1).optional(),
    repositoryUrl: z.string().url().optional(),
    localPath: z.string().min(1).optional(),
    provisioning: provisioning.optional(),
    folderName: folderName.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const kind =
      value.provisioning?.kind ??
      (value.localPath ? "existing" : value.repositoryUrl ? "clone" : "empty");
    if (value.provisioning && (value.localPath || value.repositoryUrl))
      ctx.addIssue({
        code: "custom",
        message: "Do not mix explicit provisioning with legacy path or URL",
      });
    if (kind === "existing" && value.folderName)
      ctx.addIssue({
        code: "custom",
        message: "folderName requires empty or clone provisioning",
      });
  });

export const projects = t.router({
  listProjects: {
    method: "GET",
    path: "/api/v1/projects",
    query: c.pagination,
    responses: { 200: c.page(d.project), ...c.errors },
    summary: "List projects",
  },
  createProject: {
    method: "POST",
    path: "/api/v1/projects",
    body: createProjectInput,
    responses: { 201: d.project, ...c.errors },
    summary: "Create a project",
    description:
      "Provision an empty directory, clone a repository or register an existing path. Optional folderName is one safe, unused segment for empty/clone, independent of name and ID. Legacy repositoryUrl/localPath remain compatible; when both are supplied the path is registered and the URL is metadata. Explicit provisioning cannot be mixed with those legacy fields. Backends validate accessible roots and may reject unavailable paths.",
  },
  getProject: {
    method: "GET",
    path: "/api/v1/projects/:projectId",
    pathParams: path,
    responses: { 200: d.project, ...c.errors },
    summary: "Get a project",
  },
  updateProject: {
    method: "PATCH",
    path: "/api/v1/projects/:projectId",
    pathParams: path,
    body: z.object({ name: z.string().trim().min(1) }).strict(),
    responses: { 200: d.project, ...c.errors },
    summary: "Rename a project without moving its working directory",
    description:
      "Change the display label only; localPath and working files remain fixed. Delete and recreate a project to select a different path.",
  },
  deleteProject: {
    method: "DELETE",
    path: "/api/v1/projects/:projectId",
    pathParams: path,
    responses: { 200: c.success, ...c.errors },
    summary: "Remove a project",
  },
});
