import { createApp } from "./index.js";
import { once } from "node:events";
const app = createApp({ token: process.env.API_TOKEN ?? "dev-token" });
const server = app.listen(
  Number(process.env.PORT ?? 3091),
  process.env.HOST ?? "127.0.0.1",
);
await once(server, "listening");
console.log(
  `REST contract server listening at ${JSON.stringify(server.address())}`,
);
