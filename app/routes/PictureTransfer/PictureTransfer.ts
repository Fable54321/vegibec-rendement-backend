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

const router = express.Router();

const PICTURE_PREFIX = "picture-transfer";
const MAX_FILES_PER_UPLOAD = 50;
const MAX_FILE_SIZE_BYTES = 250 * 1024 * 1024;
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

router.post("/", uploadPictures, async (req, res) => {
  const files = req.files as Express.Multer.File[] | undefined;

  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No pictures were uploaded" });
  }

  try {
    const pictures = await Promise.all(
      files.map(async (file) => {
        const key = getPictureKey(file.originalname);

        await uploadBufferToS3({
          key,
          buffer: file.buffer,
          contentType: file.mimetype || "application/octet-stream",
        });

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
          key,
          file_name: file.originalname,
          content_type: file.mimetype,
          size_bytes: file.size,
          view_url,
          download_url,
        };
      }),
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

router.get("/", async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit) || 100;
    const limit = Math.min(Math.max(requestedLimit, 1), 1000);
    const continuationToken =
      typeof req.query.continuationToken === "string"
        ? req.query.continuationToken
        : undefined;

    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: getBucketName(),
        Prefix: `${PICTURE_PREFIX}/`,
        MaxKeys: limit,
        ContinuationToken: continuationToken,
      }),
    );

    const pictures = await Promise.all(
      (result.Contents || [])
        .filter((item) => item.Key && !item.Key.endsWith("/"))
        .map(async (item) => {
          const key = item.Key as string;
          const fileName = path.basename(key).replace(
            /^\d+-[a-z0-9]+-/,
            "",
          );

          const view_url = await getSignedPictureUrl({ key });
          const download_url = await getSignedPictureUrl({
            key,
            download: true,
            fileName,
          });

          return {
            key,
            file_name: fileName,
            size_bytes: item.Size || 0,
            uploaded_at: item.LastModified,
            view_url,
            download_url,
          };
        }),
    );

    return res.status(200).json({
      pictures,
      next_continuation_token: result.NextContinuationToken || null,
      is_truncated: Boolean(result.IsTruncated),
    });
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
