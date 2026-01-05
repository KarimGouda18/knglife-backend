// src/routes/dev/index.ts
import { Router } from "express";
import { devAuthRouter } from "./auth.js";
import { devWhoamiRouter } from "./whoami.js";

export const devRouter = Router();

devRouter.get("/", (_req, res) => res.status(200).json({ ok: true, scope: "dev" }));
devRouter.use("/auth", devAuthRouter);
devRouter.use("/whoami", devWhoamiRouter);
