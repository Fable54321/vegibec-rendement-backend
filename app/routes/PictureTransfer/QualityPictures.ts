import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import express from "express";
import multer from "multer";
import path from "path";
import { pool } from "../../db";
import { s3 } from "../../s3";
import { uploadBufferToS3 } from "../../services/s3.services";

const router = express.Router();

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_FILES_PER_UPLOAD = 10;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const PICTURE_PREFIX = "picture-transfer";
const SIGNED_URL_EXPIRES_SECONDS = 60 * 60;

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_FILES_PER_UPLOAD,
    fileSize: MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();

    if (
      file.mimetype.startsWith("image/") ||
      SUPPORTED_IMAGE_EXTENSIONS.has(extension)
    ) {
      callback(null, true);
      return;
    }

    callback(new Error("Only image files can be uploaded"));
  },
});

const uploadPictures = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  upload.array("pictures", MAX_FILES_PER_UPLOAD)(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: `Picture is too large. Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB.`,
        });
      }

      if (error.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({
          error: `Too many pictures. Maximum is ${MAX_FILES_PER_UPLOAD}.`,
        });
      }
    }

    return res.status(400).json({
      error: error instanceof Error ? error.message : "Failed to upload pictures",
    });
  });
};

const getBucketName = () => {
  const bucket = process.env.AWS_BUCKET_NAME;

  if (!bucket) {
    throw new Error("AWS_BUCKET_NAME is not defined");
  }

  return bucket;
};

const getLimit = (value: unknown) => {
  if (typeof value !== "string" || value.trim() === "") {
    return DEFAULT_LIMIT;
  }

  const parsedLimit = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedLimit)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(parsedLimit, 1), MAX_LIMIT);
};

const getFileName = (key: string) =>
  path.basename(key).replace(/^\d+-[a-z0-9]+-/, "");

const sanitizeFileName = (fileName: string) => {
  const parsed = path.parse(fileName);
  const baseName = parsed.name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${baseName || "picture"}${parsed.ext.toLowerCase()}`;
};

const getPictureKey = (fileName: string) => {
  const now = new Date();
  const randomSuffix = Math.random().toString(36).slice(2, 10);

  return [
    PICTURE_PREFIX,
    now.toISOString().slice(0, 10),
    `${now.getTime()}-${randomSuffix}-${sanitizeFileName(fileName)}`,
  ].join("/");
};

router.post("/", uploadPictures, async (req, res) => {
  const files = req.files as Express.Multer.File[] | undefined;

  if (!files?.length) {
    return res.status(400).json({ error: "No pictures were uploaded" });
  }

  const description =
    typeof req.body.description === "string"
      ? req.body.description.trim().slice(0, 1000) || null
      : null;
  const equipmentName =
    typeof req.body.equipment_name === "string"
      ? req.body.equipment_name.trim().slice(0, 150) || null
      : null;

  try {
    const pictures = await Promise.all(
      files.map(async (file) => {
        const key = getPictureKey(file.originalname);
        const contentType = file.mimetype || "application/octet-stream";

        await uploadBufferToS3({ key, buffer: file.buffer, contentType });

        const result = await pool.query(
          `
          INSERT INTO toolboxes_inventory.pictures (
            s3_key,
            description,
            equipment_name
          )
          VALUES ($1, $2, $3)
          RETURNING id, description, equipment_name, created_at
          `,
          [key, description, equipmentName],
        );
        const row = result.rows[0];

        const viewUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: getBucketName(), Key: key }),
          { expiresIn: SIGNED_URL_EXPIRES_SECONDS },
        );

        return {
          id: row.id,
          key,
          view_url: viewUrl,
          description: row.description,
          equipment_name: row.equipment_name,
          created_at: row.created_at,
          file_name: file.originalname,
          content_type: contentType,
          size_bytes: file.size,
        };
      }),
    );

    return res.status(201).json({
      message: "Pictures uploaded successfully",
      pictures,
    });
  } catch (error) {
    console.error("Error uploading quality pictures:", error);
    return res.status(500).json({ error: "Failed to upload quality pictures" });
  }
});

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, s3_key, description, equipment_name, created_at
      FROM toolboxes_inventory.pictures
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [getLimit(req.query.limit)],
    );

    const pictures = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        view_url: await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: getBucketName(),
            Key: row.s3_key,
          }),
          { expiresIn: SIGNED_URL_EXPIRES_SECONDS },
        ),
        description: row.description,
        equipment_name: row.equipment_name,
        created_at: row.created_at,
        file_name: getFileName(row.s3_key),
      })),
    );

    return res.status(200).json({ pictures });
  } catch (error) {
    console.error("Error listing quality pictures:", error);
    return res.status(500).json({ error: "Failed to list quality pictures" });
  }
});

export default router;
