// src/routes/dev/whoami.ts
import { Router } from "express";
import { requireAuth } from "../../shared/middleware/requireAuth.js";

export const devWhoamiRouter = Router();

devWhoamiRouter.get("/", requireAuth, async (req, res) => {
  return res.status(200).json({ ok: true, user: req.user });
});
