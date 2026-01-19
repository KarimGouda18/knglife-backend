// src/routes/dev/index.ts
import { Router } from "express";
import { devAuthRouter } from "./auth.js";
import { devWhoamiRouter } from "./whoami.js";
import { devAssistantsRouter } from "./assistants.js";
import { devCommunityRouter } from "./community.js";
import { devConversationsRouter } from "./conversations.js";
import { devMeRouter } from "./me.js";
import { devGroupsRouter } from "./groups.js";
import { devGroupConversationsRouter } from "./groupConversations.js";

export const devRouter = Router();

devRouter.use("/auth", devAuthRouter);
devRouter.use("/whoami", devWhoamiRouter);
devRouter.use("/me", devMeRouter);

devRouter.use("/assistants", devAssistantsRouter);
devRouter.use("/community", devCommunityRouter);
devRouter.use("/conversations", devConversationsRouter);

// ✅ gruppi (privati)
devRouter.use("/groups", devGroupsRouter);
devRouter.use("/group-conversations", devGroupConversationsRouter);
