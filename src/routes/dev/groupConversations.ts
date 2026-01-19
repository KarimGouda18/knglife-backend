// src/routes/dev/groupConversations.ts
import { Router } from "express";
import { apiGroupConversationsRouter } from "../api/groupConversations.js";

export const devGroupConversationsRouter = Router();
devGroupConversationsRouter.use(apiGroupConversationsRouter);
