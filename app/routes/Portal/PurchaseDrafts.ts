import express from "express"
import crypto from "crypto"
import multer from "multer"
import path from "path"
import { pool } from "../../db"
import { requireAppRole } from "../../middleware/auth"
import { deleteObjectFromS3, getSignedUrlForKey, uploadBufferToS3 } from "../../services/s3.services"

const router = express.Router()

router.use(requireAppRole("main", ["admin", "user"]))

let schemaPromise: Promise<void> | null = null

function ensureDraftSchema() {
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS portal.purchase_request_drafts (
        id BIGSERIAL PRIMARY KEY,
        owner_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        draft_type TEXT NOT NULL CHECK (draft_type IN ('direct_order', 'regular_request')),
        title TEXT NOT NULL DEFAULT '',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS purchase_request_drafts_owner_updated_idx
        ON portal.purchase_request_drafts (owner_user_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS portal.purchase_request_draft_pictures (
        id BIGSERIAL PRIMARY KEY,
        draft_id BIGINT NOT NULL REFERENCES portal.purchase_request_drafts(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        s3_key TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS purchase_request_draft_pictures_draft_idx
        ON portal.purchase_request_draft_pictures (draft_id, created_at);
    `).then(() => undefined).catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}

const userId = (req: express.Request) => Number(req.user?.id)
const cleanType = (value: unknown) =>
  value === "direct_order" || value === "regular_request" ? value : null
const uploadPictures = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 7 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith("image/")) {
      callback(new Error("Only image files are allowed"))
      return
    }
    callback(null, true)
  },
})

const pictureExtension = (file: Express.Multer.File) => {
  const extension = path.extname(file.originalname).toLowerCase()
  if (extension && extension.length <= 10) return extension
  if (file.mimetype === "image/png") return ".png"
  if (file.mimetype === "image/webp") return ".webp"
  return ".jpg"
}

const pictureResponse = async (row: Record<string, unknown>) => ({
  id: Number(row.id),
  file_name: String(row.file_name),
  content_type: String(row.content_type),
  size_bytes: Number(row.size_bytes),
  created_at: row.created_at,
  url: await getSignedUrlForKey(String(row.s3_key), { expiresIn: 60 * 60 }),
})

router.get("/", async (req, res) => {
  try {
    await ensureDraftSchema()
    const result = await pool.query(
      `SELECT id, draft_type, title, payload, created_at, updated_at
       FROM portal.purchase_request_drafts
       WHERE owner_user_id = $1
       ORDER BY updated_at DESC`,
      [userId(req)],
    )
    return res.json(result.rows)
  } catch (error) {
    console.error("Purchase draft list error:", error)
    return res.status(500).json({ message: "Unable to load purchase drafts" })
  }
})

router.post("/", async (req, res) => {
  try {
    await ensureDraftSchema()
    const draftType = cleanType(req.body?.draft_type)
    if (!draftType) return res.status(400).json({ message: "Invalid draft type" })
    const result = await pool.query(
      `INSERT INTO portal.purchase_request_drafts (owner_user_id, draft_type, title, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, draft_type, title, payload, created_at, updated_at`,
      [userId(req), draftType, String(req.body?.title ?? "").trim().slice(0, 160), JSON.stringify(req.body?.payload ?? {})],
    )
    return res.status(201).json(result.rows[0])
  } catch (error) {
    console.error("Purchase draft creation error:", error)
    return res.status(500).json({ message: "Unable to create purchase draft" })
  }
})

router.put("/:id", async (req, res) => {
  try {
    await ensureDraftSchema()
    const draftType = cleanType(req.body?.draft_type)
    if (!draftType) return res.status(400).json({ message: "Invalid draft type" })
    const result = await pool.query(
      `UPDATE portal.purchase_request_drafts
       SET draft_type = $3, title = $4, payload = $5::jsonb, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2
       RETURNING id, draft_type, title, payload, created_at, updated_at`,
      [Number(req.params.id), userId(req), draftType, String(req.body?.title ?? "").trim().slice(0, 160), JSON.stringify(req.body?.payload ?? {})],
    )
    if (!result.rows[0]) return res.status(404).json({ message: "Draft not found" })
    return res.json(result.rows[0])
  } catch (error) {
    console.error("Purchase draft update error:", error)
    return res.status(500).json({ message: "Unable to save purchase draft" })
  }
})

router.get("/:id/pictures", async (req, res) => {
  try {
    await ensureDraftSchema()
    const result = await pool.query(
      `SELECT picture.id, picture.file_name, picture.content_type, picture.size_bytes, picture.s3_key, picture.created_at
       FROM portal.purchase_request_draft_pictures picture
       JOIN portal.purchase_request_drafts draft ON draft.id = picture.draft_id
       WHERE picture.draft_id = $1 AND draft.owner_user_id = $2
       ORDER BY picture.created_at`,
      [Number(req.params.id), userId(req)],
    )
    return res.json(await Promise.all(result.rows.map(pictureResponse)))
  } catch (error) {
    console.error("Purchase draft picture list error:", error)
    return res.status(500).json({ message: "Unable to load draft pictures" })
  }
})

router.post("/:id/pictures", uploadPictures.array("pictures", 5), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? []
  const uploadedKeys: string[] = []
  try {
    await ensureDraftSchema()
    const draftId = Number(req.params.id)
    const draft = await pool.query(
      `SELECT id, draft_type FROM portal.purchase_request_drafts WHERE id = $1 AND owner_user_id = $2`,
      [draftId, userId(req)],
    )
    if (!draft.rows[0]) return res.status(404).json({ message: "Draft not found" })
    if (draft.rows[0].draft_type !== "regular_request") return res.status(400).json({ message: "Pictures are only supported for regular requests" })

    const count = await pool.query(
      `SELECT count(*)::int AS count FROM portal.purchase_request_draft_pictures WHERE draft_id = $1`,
      [draftId],
    )
    if (Number(count.rows[0].count) + files.length > 5) return res.status(400).json({ message: "A maximum of 5 pictures is allowed" })

    const created = []
    for (const file of files) {
      const key = `purchase-request-drafts/${draftId}/pictures/${crypto.randomBytes(16).toString("hex")}${pictureExtension(file)}`
      await uploadBufferToS3({ key, buffer: file.buffer, contentType: file.mimetype })
      uploadedKeys.push(key)
      const result = await pool.query(
        `INSERT INTO portal.purchase_request_draft_pictures (draft_id, file_name, content_type, size_bytes, s3_key)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, file_name, content_type, size_bytes, s3_key, created_at`,
        [draftId, file.originalname.slice(0, 255), file.mimetype, file.size, key],
      )
      created.push(await pictureResponse(result.rows[0]))
    }
    await pool.query(`UPDATE portal.purchase_request_drafts SET updated_at = now() WHERE id = $1`, [draftId])
    return res.status(201).json(created)
  } catch (error) {
    await Promise.allSettled(uploadedKeys.map(deleteObjectFromS3))
    console.error("Purchase draft picture upload error:", error)
    return res.status(500).json({ message: error instanceof Error ? error.message : "Unable to upload draft pictures" })
  }
})

router.delete("/:id/pictures/:pictureId", async (req, res) => {
  try {
    await ensureDraftSchema()
    const result = await pool.query(
      `DELETE FROM portal.purchase_request_draft_pictures picture
       USING portal.purchase_request_drafts draft
       WHERE picture.id = $1 AND picture.draft_id = $2
         AND draft.id = picture.draft_id AND draft.owner_user_id = $3
       RETURNING picture.s3_key`,
      [Number(req.params.pictureId), Number(req.params.id), userId(req)],
    )
    if (!result.rows[0]) return res.status(404).json({ message: "Picture not found" })
    await deleteObjectFromS3(result.rows[0].s3_key)
    return res.status(204).send()
  } catch (error) {
    console.error("Purchase draft picture deletion error:", error)
    return res.status(500).json({ message: "Unable to delete draft picture" })
  }
})

router.delete("/:id", async (req, res) => {
  try {
    await ensureDraftSchema()
    const result = await pool.query(
      `WITH picture_keys AS (
         SELECT COALESCE(array_agg(picture.s3_key), ARRAY[]::text[]) AS keys
         FROM portal.purchase_request_draft_pictures picture
         JOIN portal.purchase_request_drafts draft ON draft.id = picture.draft_id
         WHERE draft.id = $1 AND draft.owner_user_id = $2
       ), deleted AS (
         DELETE FROM portal.purchase_request_drafts WHERE id = $1 AND owner_user_id = $2 RETURNING id
       )
       SELECT deleted.id, picture_keys.keys FROM deleted CROSS JOIN picture_keys`,
      [Number(req.params.id), userId(req)],
    )
    if (!result.rows[0]) return res.status(404).json({ message: "Draft not found" })
    const referenced = await pool.query(
      `SELECT DISTINCT key
       FROM portal.purchase_requests request,
       unnest(COALESCE(request.picture_keys, ARRAY[]::text[])) AS key
       WHERE key = ANY($1::text[])`,
      [result.rows[0].keys],
    )
    const referencedKeys = new Set(referenced.rows.map((row) => String(row.key)))
    await Promise.allSettled(
      (result.rows[0].keys as string[])
        .filter((key) => !referencedKeys.has(key))
        .map(deleteObjectFromS3),
    )
    return res.status(204).send()
  } catch (error) {
    console.error("Purchase draft deletion error:", error)
    return res.status(500).json({ message: "Unable to delete purchase draft" })
  }
})

export default router
