import { glob, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { ESLint } from "eslint";
import config from "./eslint.config.js";
import { exclude, sourceExclude, sources, tests } from "./settings.js";

export async function structure() {
  const sizes: Record<string, number> = {};
  const production: string[] = [];
  for await (const path of glob(sources, {
    exclude: [...exclude, ...sourceExclude],
  }))
    production.push(path);
  const testing: string[] = [];
  for await (const path of glob(tests, { exclude })) testing.push(path);
  for (const path of [...production, ...testing]) {
    const text = await readFile(path, "utf8");
    sizes[path] = text.split("\n").length - Number(text.endsWith("\n"));
  }
  if (!Object.keys(sizes).length)
    throw new Error("Quality scope matched no source/test files");
  const ratios: Record<string, number> = {};
  for (const [path, count] of Object.entries(sizes)) {
    const source = path.replace(/\.test\.(ts|cjs)$/, (_, extension: string) =>
      extension === "cjs" ? ".js" : ".ts",
    );
    if (source !== path && sizes[source]) ratios[path] = count / sizes[source];
  }
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: config,
  });
  const results = await eslint.lintFiles(production);
  const complexity: Record<string, number> = {};
  for (const result of results) {
    if (result.errorCount)
      throw new Error(
        await (await eslint.loadFormatter("stylish")).format([result]),
      );
    const values = result.messages
      .map((message) => {
        if (message.ruleId !== "complexity") throw new Error(message.message);
        const match = /has a complexity of (\d+)/.exec(message.message);
        if (!match)
          throw new Error(
            `Unrecognized ESLint complexity diagnostic: ${message.message}`,
          );
        return Number(match[1]);
      })
      .sort((a, b) => b - a);
    values.forEach((value, index) => {
      complexity[`${relative(process.cwd(), result.filePath)}#${index + 1}`] =
        value;
    });
    for (const message of result.messages)
      console.log(
        `::warning file=${relative(process.cwd(), result.filePath)},line=${message.line},title=Cyclomatic complexity::${message.message}`,
      );
  }
  return { sizes, ratios, complexity };
}
