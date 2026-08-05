import crypto from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";

import { getSignedUploadUrl, getSignedUrlForKey } from "../../services/s3.services";

const router = Router();

const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_LINK_SECONDS = 60 * 60 * 24 * 7;

const createTransferLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trop de transferts ont été créés. Réessayez plus tard." },
});

const safeFilename = (value: string) => {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._ -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-180);

  return cleaned || "video";
};

router.post("/create", createTransferLimiter, async (req, res) => {
  const filename = String(req.body.filename ?? "").trim();
  const contentType = String(req.body.contentType ?? "").trim().toLowerCase();
  const size = Number(req.body.size);

  if (!filename || !contentType.startsWith("video/")) {
    return res.status(400).json({ error: "Sélectionnez un fichier vidéo valide." });
  }

  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_VIDEO_BYTES) {
    return res.status(400).json({ error: "La vidéo doit avoir une taille maximale de 2 Go." });
  }

  const normalizedFilename = safeFilename(filename);
  const key = `temporary-video-transfers/${crypto.randomUUID()}/${normalizedFilename}`;

  try {
    const [uploadUrl, downloadUrl] = await Promise.all([
      getSignedUploadUrl({ key, contentType }),
      getSignedUrlForKey(key, {
        expiresIn: DOWNLOAD_LINK_SECONDS,
        responseContentDisposition: `attachment; filename="${normalizedFilename}"`,
        responseContentType: contentType,
      }),
    ]);

    return res.status(201).json({
      uploadUrl,
      downloadUrl,
      expiresAt: new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000).toISOString(),
    });
  } catch (error) {
    console.error("Unable to create temporary video transfer:", error);
    return res.status(500).json({ error: "Impossible de créer le transfert." });
  }
});

export default router;
