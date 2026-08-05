import crypto from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";

import { getSignedUploadUrl, getSignedUrlForKey } from "../../services/s3.services";

const router = Router();

const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_LINK_SECONDS = 60 * 60 * 24 * 30;
const S3_DOWNLOAD_SECONDS = 60 * 5;

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

const signTransfer = (value: string) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("Missing JWT_SECRET");
  }

  return crypto.createHmac("sha256", secret).update(value).digest("hex");
};

const signaturesMatch = (provided: string, expected: string) => {
  if (!/^[a-f0-9]{64}$/.test(provided)) return false;

  return crypto.timingSafeEqual(
    Buffer.from(provided, "hex"),
    Buffer.from(expected, "hex"),
  );
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
  const transferId = crypto.randomUUID();
  const key = `temporary-video-transfers/${transferId}/${normalizedFilename}`;

  try {
    const uploadUrl = await getSignedUploadUrl({ key, contentType });
    const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_LINK_SECONDS;
    const signature = signTransfer(`${transferId}:${normalizedFilename}:${expires}`);
    const configuredBaseUrl = process.env.PUBLIC_BACKEND_URL?.replace(/\/$/, "");
    const baseUrl = configuredBaseUrl || `${req.protocol}://${req.get("host")}`;
    const downloadUrl = `${baseUrl}/file-transfer/download/${transferId}/${encodeURIComponent(normalizedFilename)}?expires=${expires}&signature=${signature}`;

    return res.status(201).json({
      uploadUrl,
      downloadUrl,
      expiresAt: new Date(expires * 1000).toISOString(),
    });
  } catch (error) {
    console.error("Unable to create temporary video transfer:", error);
    return res.status(500).json({ error: "Impossible de créer le transfert." });
  }
});

router.get("/download/:transferId/:filename", async (req, res) => {
  const { transferId, filename } = req.params;
  const expires = Number(req.query.expires);
  const signature = String(req.query.signature ?? "");

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transferId) ||
    safeFilename(filename) !== filename ||
    !Number.isSafeInteger(expires) ||
    expires <= Math.floor(Date.now() / 1000)
  ) {
    return res.status(410).json({ error: "Ce lien de téléchargement est invalide ou expiré." });
  }

  try {
    const expectedSignature = signTransfer(`${transferId}:${filename}:${expires}`);

    if (!signaturesMatch(signature, expectedSignature)) {
      return res.status(403).json({ error: "Lien de téléchargement invalide." });
    }

    const key = `temporary-video-transfers/${transferId}/${filename}`;
    const signedUrl = await getSignedUrlForKey(key, {
      expiresIn: S3_DOWNLOAD_SECONDS,
      responseContentDisposition: `attachment; filename="${filename}"`,
    });

    return res.redirect(302, signedUrl);
  } catch (error) {
    console.error("Unable to open temporary video transfer:", error);
    return res.status(500).json({ error: "Impossible d’ouvrir ce transfert." });
  }
});

export default router;
