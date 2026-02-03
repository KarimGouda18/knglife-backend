// src/index.ts
import { createServer } from "node:http";
import { buildApp } from "./server.js";
import { env } from "./config/env.js";
import { attachLiveWebSocketServer } from "./live/wsServer.js";
const app = buildApp();
const server = createServer(app);
// WebSocket (Gemini Live)
attachLiveWebSocketServer(server);
server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[knglife] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
    // eslint-disable-next-line no-console
    console.log(`[knglife] WS live endpoints:`);
    // eslint-disable-next-line no-console
    console.log(`  - ws://localhost:${env.PORT}/api/live/assistants/:assistantId`);
    // eslint-disable-next-line no-console
    console.log(`  - ws://localhost:${env.PORT}/api/live/interview`);
});
