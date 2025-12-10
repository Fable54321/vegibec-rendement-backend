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

router.get(
  "/totals",
  requireRole(["admin", "guest"]),
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

      // Ensure start <= end
      if (startDate > endDate) {
        return res
          .status(400)
          .json({ error: "'start' date cannot be after 'end' date." });
      }

      // ❌ Check that both dates are in the same year
      if (startDate.getFullYear() !== endDate.getFullYear()) {
        return res
          .status(400)
          .json({ error: "Date range cannot cross different years." });
      }

      // Query total units sold per vegetable
      const result = await pool.query(
        `SELECT vegetable, SUM(units_sold) AS total_units
         FROM units_sold
         WHERE date_of_sale BETWEEN $1 AND $2
         GROUP BY vegetable
         ORDER BY vegetable`,
        [startDate, endDate]
      );

      res.json({ success: true, totals: result.rows });
    } catch (err) {
      console.error("Error fetching totals:", err);
      res.status(500).json({ error: "Database error" });
    }
  }
);

export default router;
