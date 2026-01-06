// src/routes/dev/index.ts
import { Router } from "express";
import { devAuthRouter } from "./auth.js";
import { devWhoamiRouter } from "./whoami.js";
import { devAssistantsRouter } from "./assistants.js";
import { devCommunityRouter } from "./community.js";
import { devConversationsRouter } from "./conversations.js";
import { devMeInterviewRouter } from "./meInterview.js";
import { devMeRouter } from "./me.js";

export const devRouter = Router();

devRouter.get("/", (_req, res) => res.status(200).json({ ok: true, scope: "dev" }));

devRouter.use("/auth", devAuthRouter);
devRouter.use("/whoami", devWhoamiRouter);

// espongo anche interview in dev, utile per testare senza /api
devRouter.use("/me/interview", devMeInterviewRouter);

// proxy completo me (GET/PUT/DELETE) in dev
devRouter.use("/me", devMeRouter);

devRouter.use("/assistants", devAssistantsRouter);
devRouter.use("/community", devCommunityRouter);
devRouter.use("/conversations", devConversationsRouter);
