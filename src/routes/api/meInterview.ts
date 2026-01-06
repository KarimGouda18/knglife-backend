// src/routes/api/meInterview.ts
import { Router } from "express";
import { z } from "zod";
import { getFirestore } from "../../config/firebase.js";
import { requireAuth } from "../../shared/middleware/requireAuth.js";
import { getOrCreateUserProfile, updateUserProfile } from "../../modules/users/userRepo.js";
import {
  addInterviewMessage,
  createInterview,
  finishInterview,
  getInterview,
  listInterviewMessages
} from "../../modules/interview/interviewRepo.js";
import { generateInterviewSummaryBio, generateNextInterviewQuestion } from "../../modules/interview/runInterview.js";
import { sanitizeDeep } from "../../shared/utils/sanitizeDeep.js";

export const apiMeInterviewRouter = Router();
apiMeInterviewRouter.use(requireAuth);

apiMeInterviewRouter.post("/start", async (req, res, next) => {
  try {
    const db = getFirestore();
    const user = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);

    // snapshot: l'intervista segue NSFW del profilo
    const interview = await createInterview(db, req.user!.uid, user.nsfwEnabled);

    // prima domanda
    const firstQ = await generateNextInterviewQuestion({
      user,
      interviewNsfwEnabled: interview.nsfwEnabled,
      messages: []
    });

    const assistantMsg = await addInterviewMessage(db, req.user!.uid, interview.id, {
      role: "assistant",
      text: firstQ
    });

    return res.status(201).json(
      sanitizeDeep({
        ok: true,
        interview,
        firstMessage: assistantMsg
      })
    );
  } catch (err) {
    return next(err);
  }
});

apiMeInterviewRouter.get("/:interviewId", async (req, res, next) => {
  try {
    const db = getFirestore();
    const interview = await getInterview(db, req.user!.uid, req.params.interviewId);
    if (!interview) return res.status(404).json({ ok: false, error: "INTERVIEW_NOT_FOUND" });

    return res.status(200).json(sanitizeDeep({ ok: true, interview }));
  } catch (err) {
    return next(err);
  }
});

apiMeInterviewRouter.get("/:interviewId/messages", async (req, res, next) => {
  try {
    const db = getFirestore();
    const interview = await getInterview(db, req.user!.uid, req.params.interviewId);
    if (!interview) return res.status(404).json({ ok: false, error: "INTERVIEW_NOT_FOUND" });

    const messages = await listInterviewMessages(db, req.user!.uid, interview.id, 120);
    return res.status(200).json(sanitizeDeep({ ok: true, messages }));
  } catch (err) {
    return next(err);
  }
});

apiMeInterviewRouter.post("/:interviewId/message", async (req, res, next) => {
  try {
    const Body = z.object({ text: z.string().min(1).max(4000) });
    const { text } = Body.parse(req.body);

    const db = getFirestore();
    const interview = await getInterview(db, req.user!.uid, req.params.interviewId);
    if (!interview) return res.status(404).json({ ok: false, error: "INTERVIEW_NOT_FOUND" });
    if (interview.status !== "active") return res.status(409).json({ ok: false, error: "INTERVIEW_NOT_ACTIVE" });

    const user = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);

    const userMsg = await addInterviewMessage(db, req.user!.uid, interview.id, { role: "user", text });

    const messages = await listInterviewMessages(db, req.user!.uid, interview.id, 120);
    const nextQ = await generateNextInterviewQuestion({
      user,
      interviewNsfwEnabled: interview.nsfwEnabled,
      messages
    });

    const assistantMsg = await addInterviewMessage(db, req.user!.uid, interview.id, {
      role: "assistant",
      text: nextQ
    });

    return res.status(200).json(sanitizeDeep({ ok: true, userMessage: userMsg, assistantMessage: assistantMsg }));
  } catch (err) {
    return next(err);
  }
});

apiMeInterviewRouter.post("/:interviewId/finish", async (req, res, next) => {
  try {
    const db = getFirestore();
    const interview = await getInterview(db, req.user!.uid, req.params.interviewId);
    if (!interview) return res.status(404).json({ ok: false, error: "INTERVIEW_NOT_FOUND" });
    if (interview.status !== "active") return res.status(409).json({ ok: false, error: "INTERVIEW_NOT_ACTIVE" });

    const user = await getOrCreateUserProfile(db, req.user!.uid, req.user!.email ?? null);
    const messages = await listInterviewMessages(db, req.user!.uid, interview.id, 120);

    const bio = await generateInterviewSummaryBio({
      user,
      interviewNsfwEnabled: interview.nsfwEnabled,
      messages
    });

    await finishInterview(db, req.user!.uid, interview.id, bio);

    // salva bio nel profilo + onboardingCompleted
    const updatedProfile = await updateUserProfile(db, req.user!.uid, {
      bio,
      onboardingCompleted: true
    });

    return res.status(200).json(
      sanitizeDeep({
        ok: true,
        bio,
        profile: updatedProfile
      })
    );
  } catch (err) {
    return next(err);
  }
});
