import express from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = express.Router();

/**
 * POST /data/costs/unspecified
 * Body:
 * {
 *   description: string,
 *   amount: number,
 *   cost_year: number,
 *   cost_type: "annual" | "seasonal",
 *   entry_date?: string (YYYY-MM-DD)
 * }
 */
router.post("/", requireRole(["admin"]), async (req, res) => {
  try {
    const {
      description,
      amount,
      cost_year,
      cost_type,
      vegetable, // 👈 NEW
      entry_date,
    } = req.body;

    if (!description || !amount || !cost_year || !cost_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!["annual", "seasonal"].includes(cost_type)) {
      return res.status(400).json({ error: "Invalid cost_type" });
    }

    const dateValue = entry_date ? new Date(entry_date) : new Date();

    const result = await pool.query(
      `
        INSERT INTO unspecified_costs
          (description, amount, cost_year, cost_type, vegetable, entry_date)
        VALUES
          ($1, $2, $3, $4, $5, $6)
        RETURNING *
        `,
      [
        description,
        amount,
        cost_year,
        cost_type,
        vegetable || null, // 👈 important
        dateValue,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error inserting unspecified cost:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
