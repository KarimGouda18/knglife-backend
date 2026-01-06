// src/routes/dev/me.ts
import { Router } from "express";
import { apiMeRouter } from "../api/me.js";

export const devMeRouter = Router();
devMeRouter.use(apiMeRouter);
