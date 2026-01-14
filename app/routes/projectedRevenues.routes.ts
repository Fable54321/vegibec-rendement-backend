import express from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = express.Router();

/**
 * GET /projected-revenues
 * Returns all projected revenues
 */
router.get("/", requireRole(["admin", "guest"]), async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        vegetable,
        year,
        projected_revenue
      FROM projected_revenues
      ORDER BY year DESC, vegetable ASC
    `);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching projected revenues:", error);
    res.status(500).json({ error: "Failed to fetch projected revenues" });
  }
});

/**
 * POST /projected-revenues
 * Adds or updates a projected revenue
 */
router.post("/", requireRole(["admin"]), async (req, res) => {
  try {
    const { vegetable, year, projectedRevenue } = req.body;

    // 🛑 Validation
    if (
      !vegetable ||
      typeof vegetable !== "string" ||
      !year ||
      typeof year !== "number" ||
      projectedRevenue === undefined ||
      typeof projectedRevenue !== "number"
    ) {
      return res.status(400).json({
        error: "vegetable, year, and projectedRevenue are required",
      });
    }

    const normalizedVegetable = vegetable.trim().toUpperCase();

    if (!normalizedVegetable) {
      return res.status(400).json({ error: "Vegetable cannot be empty" });
    }

    if (year < 2000 || year > 2100) {
      return res.status(400).json({ error: "Invalid year" });
    }

    if (projectedRevenue < 0) {
      return res.status(400).json({ error: "Projected revenue must be >= 0" });
    }

    // 🚀 Insert or update
    const result = await pool.query(
      `
      INSERT INTO projected_revenues (vegetable, year, projected_revenue)
      VALUES ($1, $2, $3)
      ON CONFLICT (vegetable, year)
      DO UPDATE SET projected_revenue = EXCLUDED.projected_revenue
      RETURNING vegetable, year, projected_revenue
      `,
      [normalizedVegetable, year, projectedRevenue]
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error("Error saving projected revenue:", error);

    // FK violation (vegetable does not exist)
    if (error.code === "23503") {
      return res.status(400).json({
        error: "Vegetable does not exist",
      });
    }

    res.status(500).json({ error: "Failed to save projected revenue" });
  }
});

export default router;
