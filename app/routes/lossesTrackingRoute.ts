import express from "express";
import { pool } from "../db";
import { requireRole } from "../middleware/auth";

const router = express.Router();

// GET seed quantities for loss tracking
router.get("/seeds", requireRole(["admin"]), async (req, res) => {
  try {
    const { year } = req.query;

    const values: any[] = [];
    let where = "";

    if (year) {
      values.push(year);
      where = `WHERE year = $1`;
    }

    const result = await pool.query(
      `
      SELECT
        year,
        vegetable,
        SUM(units) AS units
      FROM seed_costs_new
      ${where}
      GROUP BY year, vegetable
      ORDER BY year DESC, vegetable
      `,
      values,
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Erreur losses-tracking GET seeds:", error);
    res.status(500).json({
      success: false,
      error: "Erreur serveur",
    });
  }
});

export default router;
