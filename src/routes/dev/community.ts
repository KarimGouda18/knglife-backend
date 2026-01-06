// src/routes/dev/community.ts
import { Router } from "express";
import { apiCommunityRouter } from "../api/community.js";

// In dev riusiamo la logica production-ready 1:1
export const devCommunityRouter = Router();
devCommunityRouter.use(apiCommunityRouter);
