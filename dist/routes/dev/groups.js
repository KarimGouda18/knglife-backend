// src/routes/dev/groups.ts
import { Router } from "express";
import { apiGroupsRouter } from "../api/groups.js";
export const devGroupsRouter = Router();
devGroupsRouter.use(apiGroupsRouter);
