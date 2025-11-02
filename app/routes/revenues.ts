import express, { Request, Response } from "express";
import { pool } from "../db";

const router = express.Router();

// GET /revenues/romaine-redistribution
router.get("/romaine-redistribution", async (req: Request, res: Response) => {
  try {
    const query = `
      WITH lettuce_revenues AS (
        SELECT 
          vegetable, 
          REPLACE(total_revenue::text, ',', '')::numeric AS total_revenue
        FROM revenues
        WHERE vegetable IN ('CŒUR DE ROMAINE', 'LAITUE ROMAINE')
      ),
      lettuce_costs AS (
        SELECT 
          SUM(total_cost) AS total_cost
        FROM task_costs
        WHERE vegetable IN ('CŒUR DE ROMAINE', 'LAITUE ROMAINE')
      ),
      combined AS (
        SELECT
          r.vegetable,
          r.total_revenue,
          r.total_revenue / SUM(r.total_revenue) OVER () AS revenue_ratio,
          c.total_cost
        FROM lettuce_revenues r
        CROSS JOIN lettuce_costs c
      )
      SELECT
        vegetable,
        ROUND(total_cost * revenue_ratio, 2) AS redistributed_cost
      FROM combined;
    `;

    const result = await pool.query(query);

    return res.json(result.rows);
  } catch (error) {
    console.error("Error calculating lettuce redistribution:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

router.get("/by-year", async (req: Request, res: Response) => {
  try {
    const { year_from } = req.query;

    if (!year_from) {
      return res
        .status(400)
        .json({ error: "Missing 'year_from' query parameter" });
    }

    const query = `
      SELECT 
        vegetable,
        SUM(REPLACE(total_revenue::text, ',', '')::numeric) AS total_revenue
      FROM revenues
      WHERE year_from >= $1
      GROUP BY vegetable
      ORDER BY total_revenue DESC;
    `;

    const result = await pool.query(query, [year_from]);

    return res.json(result.rows);
  } catch (error) {
    console.error("Error fetching revenues by year:", error);
    return res.status(500).json({ error: "Database error" });
  }
});

export default router;
