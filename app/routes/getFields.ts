import express from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = express.Router();

/**
 * GET /getFields
 * Returns all available field values
 */
router.get("/", requireRole(["admin", "guest"]), async (req, res) => {
  try {
    const result = await pool.query(`SELECT field FROM fields ORDER BY field`);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching fields:", error);
    res.status(500).json({ error: "Failed to fetch fields" });
  }
});

export default router;
