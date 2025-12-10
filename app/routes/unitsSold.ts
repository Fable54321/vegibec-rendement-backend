import { Router, Request, Response } from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = Router();

router.post("/send-data", requireRole(["admin"]), async (req, res) => {
  try {
    const { vegetable, units_sold, date_of_sale } = req.body;

    if (!vegetable || !units_sold) {
      return res.status(400).json({
        error: "Missing required fields: vegetable, units_sold",
      });
    }

    const saleDate = date_of_sale ? new Date(date_of_sale) : new Date();

    const result = await pool.query(
      `INSERT INTO units_sold (vegetable, units_sold, date_of_sale)
         VALUES ($1, $2, $3)
         RETURNING *`,
      [vegetable, units_sold, saleDate]
    );

    // ⭐ This is the line you add/replace:
    res.status(201).json({
      success: true,
      entry: result.rows[0],
    });
  } catch (err) {
    console.error("Error inserting units_sold:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
