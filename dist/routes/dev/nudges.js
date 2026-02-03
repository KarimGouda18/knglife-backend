// src/routes/dev/nudges.ts
import { Router } from "express";
import { apiNudgesRouter } from "../api/nudges.js";
export const devNudgesRouter = Router();
devNudgesRouter.use(apiNudgesRouter);
