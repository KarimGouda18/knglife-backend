// src/routes/api/index.ts
import { Router } from "express";
import { apiAuthRouter } from "./auth.js";

export const apiRouter = Router();

apiRouter.get("/", (_req, res) => res.status(200).json({ ok: true, scope: "api" }));

apiRouter.use("/auth", apiAuthRouter);
