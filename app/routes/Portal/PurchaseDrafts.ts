import express from "express"
import { pool } from "../../db"
import { requireAppRole } from "../../middleware/auth"

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

router.delete("/:id", async (req, res) => {
  try {
    await ensureDraftSchema()
    const result = await pool.query(
      `DELETE FROM portal.purchase_request_drafts WHERE id = $1 AND owner_user_id = $2 RETURNING id`,
      [Number(req.params.id), userId(req)],
    )
    if (!result.rows[0]) return res.status(404).json({ message: "Draft not found" })
    return res.status(204).send()
  } catch (error) {
    console.error("Purchase draft deletion error:", error)
    return res.status(500).json({ message: "Unable to delete purchase draft" })
  }
})

export default router
