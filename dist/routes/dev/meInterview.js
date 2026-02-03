// src/routes/dev/meInterview.ts
import { Router } from "express";
import { apiMeInterviewRouter } from "../api/meInterview.js";
export const devMeInterviewRouter = Router();
devMeInterviewRouter.use(apiMeInterviewRouter);
