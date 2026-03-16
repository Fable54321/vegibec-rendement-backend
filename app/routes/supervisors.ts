import express from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = express.Router();

/**
 * GET /getSupervisors
 * Returns all supervisors
 */
router.get(
  "/get",
  requireRole(["admin", "user", "guest"]),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT supervisor FROM supervisors ORDER BY supervisor`,
      );

      res.status(200).json(result.rows);
    } catch (error) {
      console.error("Error fetching supervisors:", error);
      res.status(500).json({ error: "Failed to fetch supervisors" });
    }
  },
);

router.post("/", requireRole(["admin"]), async (req, res) => {
  const { supervisor } = req.body;

  if (!supervisor || typeof supervisor !== "string") {
    return res.status(400).json({ error: "Supervisor name is required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO supervisors (supervisor)
       VALUES ($1)
       RETURNING supervisor`,
      [supervisor.trim()],
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error("Error adding supervisor:", error);

    // Optional: unique constraint
    if (error.code === "23505") {
      return res.status(409).json({ error: "Supervisor already exists" });
    }

    res.status(500).json({ error: "Failed to add supervisor" });
  }
});

/**
 * DELETE /:supervisor
 * Delete a supervisor
 */
router.delete("/:supervisor", requireRole(["admin"]), async (req, res) => {
  const { supervisor } = req.params;

  if (!supervisor) {
    return res.status(400).json({ error: "Supervisor name is required" });
  }

  try {
    const result = await pool.query(
      `DELETE FROM supervisors
       WHERE supervisor = $1
       RETURNING supervisor`,
      [supervisor],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Supervisor not found" });
    }

    res.status(200).json({ deleted: result.rows[0].supervisor });
  } catch (error) {
    console.error("Error deleting supervisor:", error);
    res.status(500).json({ error: "Failed to delete supervisor" });
  }
});

export default router;
