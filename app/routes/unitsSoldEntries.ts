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
router.get("/", requireRole(["admin", "user", "guest"]), async (req, res) => {
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
        `date_of_sale BETWEEN $${values.length + 1} AND $${values.length + 2}`,
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

/**
 * DELETE /units-sold/:id
 * "Deletes" an entry by adding a negative entry
 */
router.delete("/:id", requireRole(["admin"]), async (req, res) => {
  try {
    const { id } = req.params;

    // Find the original entry
    const original = await pool.query(
      "SELECT vegetable, units_sold, is_kg, date_of_sale FROM units_sold WHERE id = $1",
      [id],
    );

    if (original.rowCount === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }

    const entry = original.rows[0];

    // Insert a negative entry to offset
    await pool.query(
      `INSERT INTO units_sold (vegetable, units_sold, is_kg, date_of_sale)
       VALUES ($1, $2, $3, $4)`,
      [entry.vegetable, -entry.units_sold, entry.is_kg, new Date()],
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting units sold entry:", err);
    res.status(500).json({ error: "Database error" });
  }
});

/**
 * POST /units-sold/:id/correct
 * Corrects an entry by negating original and adding corrected value
 * Body: { units_sold: number, date_of_sale?: string, is_kg?: boolean }
 */
router.post("/:id/correct", requireRole(["admin"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { units_sold, date_of_sale, is_kg } = req.body;

    if (units_sold === undefined) {
      return res.status(400).json({ error: "units_sold is required" });
    }

    // Find the original entry
    const original = await pool.query(
      "SELECT vegetable, units_sold, is_kg, date_of_sale FROM units_sold WHERE id = $1",
      [id],
    );

    if (original.rowCount === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }

    const entry = original.rows[0];

    // Step 1: negate original entry
    await pool.query(
      `INSERT INTO units_sold (vegetable, units_sold, is_kg, date_of_sale)
       VALUES ($1, $2, $3, $4)`,
      [entry.vegetable, -entry.units_sold, entry.is_kg, new Date()],
    );

    // Step 2: insert corrected entry
    await pool.query(
      `INSERT INTO units_sold (vegetable, units_sold, is_kg, date_of_sale)
       VALUES ($1, $2, $3, $4)`,
      [
        entry.vegetable,
        units_sold,
        is_kg ?? entry.is_kg,
        date_of_sale ?? new Date(),
      ],
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error correcting units sold entry:", err);
    res.status(500).json({ error: "Database error" });
  }
});

export default router;
