// src/routes/dev/assistants.ts
import { Router } from "express";
import { apiAssistantsRouter } from "../api/assistants.js";

// In dev riusiamo la logica production-ready 1:1
export const devAssistantsRouter = Router();
devAssistantsRouter.use(apiAssistantsRouter);
