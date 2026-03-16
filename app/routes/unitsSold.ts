import { Router, Request, Response } from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = Router();

router.post(
  "/send-data",
  requireRole(["admin"]),
  async (req: Request, res: Response) => {
    try {
      const { vegetable, value, is_kg, date_of_sale } = req.body;

      if (!vegetable || value == null) {
        return res.status(400).json({
          error: "Missing required fields: vegetable, value",
        });
      }

      if (vegetable === "CHOU DE BRUXELLES" && !is_kg) {
        return res.status(400).json({
          error: "Missing required field: is_kg for CHOU DE BRUXELLES",
        });
      }

      const saleDate = date_of_sale ? new Date(date_of_sale) : new Date();

      const result = await pool.query(
        `INSERT INTO units_sold (vegetable, units_sold, is_kg, date_of_sale)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
        [vegetable, value, is_kg || false, saleDate],
      );

      res.status(201).json({
        success: true,
        entry: result.rows[0],
      });
    } catch (err) {
      console.error("Error inserting units_sold:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

router.get(
  "/totals",
  requireRole(["admin", "user", "guest"]),
  async (req: Request, res: Response) => {
    try {
      const { start, end } = req.query as { start?: string; end?: string };

      if (!start || !end) {
        return res
          .status(400)
          .json({ error: "Missing 'start' or 'end' query parameter." });
      }

      const startDate = new Date(start);
      const endDate = new Date(end);

      if (startDate > endDate) {
        return res
          .status(400)
          .json({ error: "'start' date cannot be after 'end' date." });
      }

      if (startDate.getFullYear() !== endDate.getFullYear()) {
        return res
          .status(400)
          .json({ error: "Date range cannot cross different years." });
      }

      const result = await pool.query(
        `SELECT vegetable,
                SUM(CASE WHEN is_kg = false THEN units_sold ELSE 0 END) AS total_units,
                SUM(CASE WHEN is_kg = true THEN units_sold ELSE 0 END) AS total_kg
         FROM units_sold
         WHERE date_of_sale BETWEEN $1 AND $2
         GROUP BY vegetable
         ORDER BY vegetable`,
        [startDate, endDate],
      );

      res.json({ success: true, totals: result.rows });
    } catch (err) {
      console.error("Error fetching totals:", err);
      res.status(500).json({ error: "Database error" });
    }
  },
);

export default router;
