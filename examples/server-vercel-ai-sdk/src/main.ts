import { createApp } from "../../server-express/src/index.js";
import { createBackend } from "./backend.js";

const apiToken = process.env.API_TOKEN;
if (!apiToken?.trim()) throw new Error("API_TOKEN must be set");
const openAiApiKey = process.env.OPENAI_API_KEY;
if (!openAiApiKey?.trim()) throw new Error("OPENAI_API_KEY must be set");
if (apiToken === openAiApiKey)
  throw new Error("API_TOKEN must differ from OPENAI_API_KEY");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3096);
const app = createApp({ token: apiToken, implementation: createBackend() });

app.listen(port, host, () => {
  console.log(`Vercel AI SDK example listening on http://${host}:${port}`);
  console.log("Model: openai/gpt-6-luna");
});
