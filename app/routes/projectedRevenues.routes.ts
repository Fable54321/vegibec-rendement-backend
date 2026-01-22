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
        projected_revenue,
        generic_group
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
    const { vegetable, year, projectedRevenue, generic_group } = req.body;

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

    // Optional generic group (no normalization here — DB trigger handles it)
    if (
      generic_group !== undefined &&
      generic_group !== null &&
      typeof generic_group !== "string"
    ) {
      return res.status(400).json({
        error: "generic_group must be a string or null",
      });
    }

    // 🚀 Insert or update
    const result = await pool.query(
      `
      INSERT INTO projected_revenues (
        vegetable,
        year,
        projected_revenue,
        generic_group
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (vegetable, year)
      DO UPDATE SET
        projected_revenue = EXCLUDED.projected_revenue,
        generic_group = EXCLUDED.generic_group
      RETURNING
        vegetable,
        year,
        projected_revenue,
        generic_group
      `,
      [normalizedVegetable, year, projectedRevenue, generic_group ?? null],
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

/**
 * DELETE /projected-revenues/:vegetable/:year
 * Deletes a projected revenue for a specific vegetable and year
 */
router.delete("/:vegetable/:year", requireRole(["admin"]), async (req, res) => {
  try {
    const { vegetable, year } = req.params;

    if (!vegetable || !year) {
      return res.status(400).json({ error: "Vegetable and year are required" });
    }

    const normalizedVegetable = vegetable.trim().toUpperCase();
    const numericYear = Number(year);

    if (isNaN(numericYear) || numericYear < 2000 || numericYear > 2100) {
      return res.status(400).json({ error: "Invalid year" });
    }

    const result = await pool.query(
      `
        DELETE FROM projected_revenues
        WHERE vegetable = $1 AND year = $2
        RETURNING vegetable, year, projected_revenue
        `,
      [normalizedVegetable, numericYear],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: `No projected revenue found for ${normalizedVegetable} in ${numericYear}`,
      });
    }

    res.status(200).json({
      message: "Projected revenue deleted successfully",
      deleted: result.rows[0],
    });
  } catch (error) {
    console.error("Error deleting projected revenue:", error);
    res.status(500).json({ error: "Failed to delete projected revenue" });
  }
});

export default router;
