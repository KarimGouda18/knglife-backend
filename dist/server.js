// src/server.ts
import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { apiRouter } from "./routes/api/index.js";
import { devRouter } from "./routes/dev/index.js";
import { notFoundHandler } from "./shared/errors/notFound.js";
import { errorHandler } from "./shared/errors/errorHandler.js";
export function buildApp() {
    const app = express();
    app.set("trust proxy", true);
    app.use(cors({ origin: true, credentials: true }));
    app.use(express.json({ limit: "20mb" }));
    app.use(express.urlencoded({ extended: true }));
    app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
    app.use("/api", apiRouter);
    // /dev/* solo in non-prod
    if (env.NODE_ENV !== "production") {
        app.use("/dev", devRouter);
    }
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
}
