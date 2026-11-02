import express from "express"
import { pool } from "../../db"
import { requireAppRole } from "../../middleware/auth"

const router = express.Router()

const readRoles = requireAppRole("main", ["admin", "user", "guest"])
const writeRoles = requireAppRole("main", ["admin", "user", "guest"])


router.get("/:workerId", readRoles, async (req, res) => {
  try {
    const workerId = Number(req.params.workerId);

    if (!Number.isInteger(workerId) || workerId <= 0) {
      return res.status(400).json({
        message: "Identifiant du travailleur invalide",
      });
    }

    const { rows } = await pool.query(
      `
      SELECT
        wn.*,
        u.name AS author_name,
        u.surname AS author_surname
      FROM portal.worker_notes wn
      LEFT JOIN public.users u
        ON u.id = wn.created_by_user_id
      WHERE wn.worker_id = $1
      ORDER BY wn.created_at DESC, wn.id DESC
      `,
      [workerId]
    );

    return res.status(200).json(rows);
  } catch (error) {
    console.error("Erreur récupération notes:", error);

    return res.status(500).json({
      message: "Erreur lors de la récupération des notes",
    });
  }
});

router.post("/", writeRoles, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Non authentifié" });
    }

    const createdByUserId = req.user.id;
    const { worker_id, content } = req.body;

    if (
      !Number.isInteger(Number(worker_id)) ||
      Number(worker_id) <= 0 ||
      typeof content !== "string" ||
      !content.trim()
    ) {
      return res.status(400).json({
        message: "Travailleur ou contenu invalide",
      });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO portal.worker_notes (
        worker_id,
        created_by_user_id,
        content
      )
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [Number(worker_id), createdByUserId, content.trim()]
    );

    return res.status(201).json(rows[0]);
  } catch (error) {
    console.error("Erreur création note:", error);

    return res.status(500).json({
      message: "Erreur lors de la création de la note",
    });
  }
});

export default router;