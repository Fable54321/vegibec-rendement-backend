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

router.get(
  "/data/costs/unspecified",
  requireRole(["admin", "guest"]),
  async (req, res) => {
    try {
      const { start, end } = req.query;

      const startDate = start ? new Date(start as string) : null;
      const endDate = end ? new Date(end as string) : null;
      const today = new Date();
      const year = startDate ? startDate.getFullYear() : today.getFullYear();

      // Fetch all unspecified costs for the year
      const result = await pool.query(
        `SELECT vegetable, cost_type, cost_year, amount 
         FROM unspecified_costs 
         WHERE cost_year = $1`,
        [year]
      );

      const startOfYear = new Date(year, 0, 1);
      const endOfYear = new Date(year, 11, 31);

      const rangeStart = startDate || startOfYear;
      const rangeEnd = endDate || today;

      const computed = result.rows.map((row: any) => {
        let dailyCost = 0;
        let periodStart: Date = new Date(0);
        let periodEnd: Date = new Date(0);

        if (row.cost_type === "annual") {
          // Annual: divide by total days in the year
          const isLeap =
            year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
          const daysInYear = isLeap ? 366 : 365;
          dailyCost = Number(row.amount) / daysInYear;

          periodStart = startOfYear;
          periodEnd = endOfYear;
        } else if (row.cost_type === "seasonal") {
          // Seasonal: divide by 260 days (Mar 1 → Nov 15)
          dailyCost = Number(row.amount) / 260;

          periodStart = new Date(year, 2, 1); // Mar 1
          periodEnd = new Date(year, 10, 15); // Nov 15
        }

        const overlapStart =
          rangeStart > periodStart ? rangeStart : periodStart;
        const overlapEnd = rangeEnd < periodEnd ? rangeEnd : periodEnd;

        const timeDiff = overlapEnd.getTime() - overlapStart.getTime();
        const overlapDays =
          timeDiff >= 0 ? Math.floor(timeDiff / (1000 * 60 * 60 * 24)) + 1 : 0;

        return {
          vegetable: row.vegetable,
          partial_cost: dailyCost * overlapDays,
        };
      });

      // Sum by vegetable
      const totals: Record<string, number> = {};
      computed.forEach((row) => {
        if (!totals[row.vegetable]) totals[row.vegetable] = 0;
        totals[row.vegetable] += row.partial_cost;
      });

      const finalResult = Object.keys(totals).map((veg) => ({
        vegetable: veg,
        total_cost: totals[veg],
      }));

      return res.json(finalResult);
    } catch (err) {
      console.error("Error fetching unspecified costs:", err);
      res.status(500).json({ error: "Database error" });
    }
  }
);

export default router;
