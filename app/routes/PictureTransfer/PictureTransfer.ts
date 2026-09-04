import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import express from "express";
import multer from "multer";
import path from "path";
import { s3 } from "../../s3";
import { uploadBufferToS3 } from "../../services/s3.services";
import { pool } from "../../db";

const router = express.Router();

const PICTURE_PREFIX = "picture-transfer";
const MAX_FILES_PER_UPLOAD = 1000;
const MAX_FILE_SIZE_BYTES = 250 * 1024 * 1024;
const UPLOAD_PROCESSING_CONCURRENCY = 10;
const SIGNED_URL_EXPIRES_SECONDS = 60 * 60;

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_UPLOAD,
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
  upload.any()(req, res, (err) => {
    if (!err) {
      return next();
    }

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: `One picture is too large. Maximum size is ${Math.round(
            MAX_FILE_SIZE_BYTES / 1024 / 1024,
          )} MB per picture.`,
        });
      }

      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({
          error: `Too many pictures. Maximum is ${MAX_FILES_PER_UPLOAD} pictures per upload.`,
        });
      }
    }

    return res.status(400).json({
      error: err instanceof Error ? err.message : "Failed to upload pictures",
    });
  });
};

const sanitizeFileName = (fileName: string) => {
  const parsed = path.parse(fileName);
  const baseName = parsed.name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  const extension = parsed.ext.toLowerCase();

  return `${baseName || "picture"}${extension}`;
};

const getPictureKey = (fileName: string) => {
  const now = new Date();
  const datePrefix = now.toISOString().slice(0, 10);
  const randomSuffix = Math.random().toString(36).slice(2, 10);

  return [
    PICTURE_PREFIX,
    datePrefix,
    `${now.getTime()}-${randomSuffix}-${sanitizeFileName(fileName)}`,
  ].join("/");
};

const getBucketName = () => {
  const bucket = process.env.AWS_BUCKET_NAME;

  if (!bucket) {
    throw new Error("AWS_BUCKET_NAME is not defined");
  }

  return bucket;
};

const mapInBatches = async <T, R>(
  items: T[],
  batchSize: number,
  mapper: (item: T) => Promise<R>,
) => {
  const results: R[] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map(mapper));
    results.push(...batchResults);
  }

  return results;
};

const getPictureKeyFromRequest = (req: express.Request) => {
  if (typeof req.query.key === "string") {
    return req.query.key;
  }

  if (
    req.body &&
    typeof req.body === "object" &&
    typeof req.body.key === "string"
  ) {
    return req.body.key;
  }

  return "";
};

const getSignedPictureUrl = async ({
  key,
  download,
  fileName,
  contentType,
}: {
  key: string;
  download?: boolean;
  fileName?: string;
  contentType?: string;
}) => {
  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    ResponseContentDisposition: download
      ? `attachment; filename="${(fileName || path.basename(key)).replace(
          /"/g,
          "",
        )}"`
      : undefined,
    ResponseContentType: contentType,
  });

  return getSignedUrl(s3, command, {
    expiresIn: SIGNED_URL_EXPIRES_SECONDS,
  });
};

/* Disabled: this bulk upload route was created for a one-time operation.
router.post("/", uploadPictures, async (req, res) => {
  const files = req.files as Express.Multer.File[] | undefined;

  if (!files || files.length === 0) {
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
    const pictures = await mapInBatches(
      files,
      UPLOAD_PROCESSING_CONCURRENCY,
      async (file) => {
        const key = getPictureKey(file.originalname);

        await uploadBufferToS3({
          key,
          buffer: file.buffer,
          contentType: file.mimetype || "application/octet-stream",
        });

        const insertResult = await pool.query(
          `
          INSERT INTO toolboxes_inventory.pictures (
            s3_key,
            description,
            equipment_name
          )
          VALUES ($1, $2, $3)
          RETURNING id, s3_key, description, equipment_name, created_at
          `,
          [key, description, equipmentName],
        );

        const dbPicture = insertResult.rows[0];

        const view_url = await getSignedPictureUrl({
          key,
          contentType: file.mimetype,
        });

        const download_url = await getSignedPictureUrl({
          key,
          download: true,
          fileName: file.originalname,
          contentType: file.mimetype,
        });

        return {
          id: dbPicture.id,
          key: dbPicture.s3_key,
          description: dbPicture.description,
          equipment_name: dbPicture.equipment_name,
          created_at: dbPicture.created_at,
          file_name: file.originalname,
          content_type: file.mimetype,
          size_bytes: file.size,
          view_url,
          download_url,
        };
      },
    );

    return res.status(201).json({
      message: "Pictures uploaded successfully",
      pictures,
    });
  } catch (error) {
    console.error("Error uploading pictures:", error);
    return res.status(500).json({ error: "Failed to upload pictures" });
  }
});
*/

router.get("/", async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit) || 100;
    const limit = Math.min(Math.max(requestedLimit, 1), 1000);

    const result = await pool.query(
      `
      SELECT id, s3_key, description, equipment_name, created_at
      FROM toolboxes_inventory.pictures
      WHERE s3_key LIKE $1
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [`${PICTURE_PREFIX}/%`, limit],
    );

    const pictures = await Promise.all(
      result.rows.map(async (row) => {
        const key = row.s3_key;
        const fileName = path.basename(key).replace(/^\d+-[a-z0-9]+-/, "");

        const view_url = await getSignedPictureUrl({ key });
        const download_url = await getSignedPictureUrl({
          key,
          download: true,
          fileName,
        });

        return {
          id: row.id,
          key,
          description: row.description,
          equipment_name: row.equipment_name,
          created_at: row.created_at,
          file_name: fileName,
          view_url,
          download_url,
        };
      }),
    );

    return res.status(200).json({ pictures });
  } catch (error) {
    console.error("Error listing pictures:", error);
    return res.status(500).json({ error: "Failed to list pictures" });
  }
});

router.get("/download-url", async (req, res) => {
  const key = typeof req.query.key === "string" ? req.query.key : "";

  if (!key.startsWith(`${PICTURE_PREFIX}/`)) {
    return res.status(400).json({ error: "Invalid picture key" });
  }

  try {
    const download_url = await getSignedPictureUrl({
      key,
      download: true,
      fileName: path.basename(key).replace(/^\d+-[a-z0-9]+-/, ""),
    });

    return res.status(200).json({ key, download_url });
  } catch (error) {
    console.error("Error creating picture download URL:", error);
    return res.status(500).json({ error: "Failed to create download URL" });
  }
});

router.delete("/", async (req, res) => {
  const key = getPictureKeyFromRequest(req);

  if (!key.startsWith(`${PICTURE_PREFIX}/`)) {
    return res.status(400).json({ error: "Invalid picture key" });
  }

  try {
 await s3.send(
  new DeleteObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  }),
);

await pool.query(
  `
  DELETE FROM toolboxes_inventory.pictures
  WHERE s3_key = $1
  `,
  [key],
);

    return res.status(200).json({
      message: "Picture deleted successfully",
      key,
    });
  } catch (error) {
    console.error("Error deleting picture:", error);
    return res.status(500).json({ error: "Failed to delete picture" });
  }
});

export default router;
