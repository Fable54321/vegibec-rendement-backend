import { Router } from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = Router();

// Only admin can fix fields
router.patch("/", requireRole(["admin"]), async (req, res) => {
  try {
    const { ids, field } = req.body;

    if (!field) {
      return res.status(400).json({ error: "Field is required" });
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "At least one id is required" });
    }

    const result = await pool.query(
      `UPDATE task_costs
       SET field = $1
       WHERE id = ANY($2::int[])
       RETURNING *`,
      [field, ids]
    );

    res.status(200).json({
      message: `${result.rows.length} entries updated successfully`,
      updated: result.rows,
    });
  } catch (err) {
    console.error("Error updating fields:", err);
    res.status(500).json({ error: "Database error" });
  }
});
