// src/shared/utils/storage.ts
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { getStorage } from "../../config/firebase.js";

export type UploadedFileInfo = {
  bucket: string;
  path: string;
  contentType: string;
  size: number;
  downloadToken: string;
  downloadUrl: string;
};

function encodePath(path: string) {
  return encodeURIComponent(path);
}

export async function uploadBytesToStorage(opts: {
  path: string;
  bytes: Buffer;
  contentType: string;
}): Promise<UploadedFileInfo> {
  const bucketName = env.FIREBASE_STORAGE_BUCKET;
  const bucket = getStorage().bucket(bucketName);

  const downloadToken = crypto.randomUUID();
  const file = bucket.file(opts.path);

  // ✅ Per video (e file grossi) evita problemi di upload con resumable=false
  const useResumable = opts.bytes.length > 5 * 1024 * 1024;

  await file.save(opts.bytes, {
    resumable: useResumable,
    contentType: opts.contentType,
    metadata: {
      metadata: {
        firebaseStorageDownloadTokens: downloadToken
      }
    }
  });

  const downloadUrl =
    `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodePath(opts.path)}` +
    `?alt=media&token=${downloadToken}`;

  return {
    bucket: bucketName,
    path: opts.path,
    contentType: opts.contentType,
    size: opts.bytes.length,
    downloadToken,
    downloadUrl
  };
}
