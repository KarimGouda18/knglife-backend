// src/routes/dev/conversations.ts
import { Router } from "express";
import { apiConversationsRouter } from "../api/conversations.js";

export const devConversationsRouter = Router();
devConversationsRouter.use(apiConversationsRouter);
