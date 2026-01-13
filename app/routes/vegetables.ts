import express from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = express.Router();

/**
 * GET /vegetables
 * Returns all available vegetable values
 */
router.get("/", requireRole(["admin", "guest"]), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT vegetable
      FROM vegetables
      ORDER BY vegetable
    `);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching vegetables:", error);
    res.status(500).json({ error: "Failed to fetch vegetables" });
  }
});

export default router;
