// src/config/firebase.ts
import admin from "firebase-admin";
import { env } from "./env.js";

let app: admin.app.App | null = null;

function normalizePrivateKey(key: string) {
  // In .env spesso arriva con "\n" letterali
  return key.replace(/\\n/g, "\n");
}

export function getFirebaseAdminApp() {
  if (app) return app;

  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: normalizePrivateKey(env.FIREBASE_PRIVATE_KEY)
    }),
    storageBucket: env.FIREBASE_STORAGE_BUCKET
  });

  return app;
}

export function getAuth() {
  getFirebaseAdminApp();
  return admin.auth();
}

export function getFirestore() {
  getFirebaseAdminApp();
  return admin.firestore();
}

export function getStorage() {
  getFirebaseAdminApp();
  return admin.storage();
}
