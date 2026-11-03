import { mkdir, writeFile } from "node:fs/promises";

process.env.SWAGGER_ENABLED = "true";

const { buildApp } = await import("../src/app.js");

const app = await buildApp({ useRedis: false, runtimeRole: "admin-api" });

try {
  await app.ready();
  const document = app.swagger();

  await mkdir("docs", { recursive: true });
  await writeFile("docs/openapi.json", `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log("Wrote docs/openapi.json");
} finally {
  await app.close();
}
