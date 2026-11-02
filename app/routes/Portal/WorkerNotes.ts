import express from "express"
import { pool } from "../../db"
import { requireAppRole } from "../../middleware/auth"

const router = express.Router()

const readRoles = requireAppRole("main", ["admin", "user", "guest"])
const writeRoles = requireAppRole("main", ["admin", "user", "guest"])


router.get("/", readRoles, async (_req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM portal.worker_notes")
        res.json(rows)
    } catch (error) {
        console.error(error)
    }
})

router.post("/", writeRoles, async (req, res) => {
    try {
        const { rows } = await pool.query("INSERT INTO portal.worker_notes (note) VALUES ($1) RETURNING *", [req.body.note])
        res.json(rows)
    } catch (error) {
        console.error(error)
    }
})

export default router;