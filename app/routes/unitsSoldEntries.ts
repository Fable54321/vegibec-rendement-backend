import { Router } from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = Router();

/**
 * GET /units-sold
 * Returns units_sold entries
 * Optional filters:
 *   ?start=YYYY-MM-DD
 *   ?end=YYYY-MM-DD
 */
router.get("/", requireRole(["admin", "guest"]), async (req, res) => {
  try {
    const { start, end } = req.query as {
      start?: string;
      end?: string;
    };

    let query = `
        SELECT
          id,
          vegetable,
          units_sold,
          is_kg,
          date_of_sale
        FROM units_sold
      `;

    const values: any[] = [];
    const conditions: string[] = [];

    if (start && end) {
      conditions.push(
        `date_of_sale BETWEEN $${values.length + 1} AND $${values.length + 2}`
      );
      values.push(start, end);
    } else if (start) {
      conditions.push(`date_of_sale >= $${values.length + 1}`);
      values.push(start);
    } else if (end) {
      conditions.push(`date_of_sale <= $${values.length + 1}`);
      values.push(end);
    }

    if (conditions.length) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY date_of_sale DESC";

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching units sold:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
