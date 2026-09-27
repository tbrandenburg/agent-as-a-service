import { initContract } from "@ts-rest/core";
import { z } from "zod";
import * as c from "./schemas/common.js";
import * as d from "./schemas/domain.js";

const t = initContract();
const path = c.pathProject;

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
    body: z.object({
      name: z.string().min(1).optional(),
      repositoryUrl: z.string().url().optional(),
      localPath: z.string().min(1).optional(),
    }),
    responses: { 201: d.project, ...c.errors },
    summary: "Create a project",
  },
  getProject: {
    method: "GET",
    path: "/api/v1/projects/:projectId",
    pathParams: path,
    responses: { 200: d.project, ...c.errors },
    summary: "Get a project",
  },
  deleteProject: {
    method: "DELETE",
    path: "/api/v1/projects/:projectId",
    pathParams: path,
    responses: { 200: c.success, ...c.errors },
    summary: "Remove a project",
  },
});
