// src/routes/api/index.ts
import { Router } from "express";
import { apiAuthRouter } from "./auth.js";
import { apiMeRouter } from "./me.js";
import { apiAssistantsRouter } from "./assistants.js";
import { apiCommunityRouter } from "./community.js";
import { apiConversationsRouter } from "./conversations.js";
import { apiGroupsRouter } from "./groups.js";
import { apiGroupConversationsRouter } from "./groupConversations.js";

export const apiRouter = Router();

apiRouter.use("/auth", apiAuthRouter);
apiRouter.use("/me", apiMeRouter);

apiRouter.use("/assistants", apiAssistantsRouter);
apiRouter.use("/community", apiCommunityRouter);

apiRouter.use("/conversations", apiConversationsRouter);

// ✅ gruppi (privati)
apiRouter.use("/groups", apiGroupsRouter);
apiRouter.use("/group-conversations", apiGroupConversationsRouter);
