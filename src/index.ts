// src/index.ts
import { createServer } from "node:http";
import { buildApp } from "./server.js";
import { env } from "./config/env.js";

const app = buildApp();
const server = createServer(app);

server.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[knglife] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});
