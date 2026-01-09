import express from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = express.Router();

/**
 * GET /getSupervisors
 * Returns all supervisors
 */
router.get("/get", requireRole(["admin", "guest"]), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT supervisor FROM supervisors ORDER BY supervisor`
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching supervisors:", error);
    res.status(500).json({ error: "Failed to fetch supervisors" });
  }
});

export default router;
