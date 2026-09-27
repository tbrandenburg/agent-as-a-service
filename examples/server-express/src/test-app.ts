import request from "supertest";
import { createApp } from "./index.js";

/** HTTP requests against the app without opening a TCP port. */
export function createTestApp(options: Parameters<typeof createApp>[0]) {
  const app = createApp(options);
  return Object.assign(app, {
    ready: async () => {},
    close: async () => {},
    inject: async ({
      method,
      url,
      headers,
      payload,
    }: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      url: string;
      headers?: Record<string, string>;
      payload?: unknown;
    }) => {
      let call =
        request(app)[method.toLowerCase() as "get" | "post" | "put" | "delete"](
          url,
        );
      if (headers) call = call.set(headers);
      if (payload !== undefined) call = call.send(payload as object);
      const result = await call;
      return {
        statusCode: result.statusCode,
        headers: result.headers,
        json: () =>
          result.body && Object.keys(result.body).length
            ? result.body
            : JSON.parse(result.text),
      };
    },
  });
}
