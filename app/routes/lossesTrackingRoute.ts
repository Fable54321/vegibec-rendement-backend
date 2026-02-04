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

router.post("/packaging", requireRole(["admin"]), async (req, res) => {
  try {
    const { vegetable, year, units } = req.body;

    // --- Validation ---
    if (!vegetable || !year || units === undefined) {
      return res.status(400).json({
        success: false,
        message: "Données manquantes",
      });
    }

    if (units <= 0) {
      return res.status(400).json({
        success: false,
        message: "Les unités doivent être supérieures à 0",
      });
    }

    const currentYear = new Date().getFullYear();
    if (year < 2000 || year > currentYear + 1) {
      return res.status(400).json({
        success: false,
        message: "Année invalide",
      });
    }

    // --- Insert with accumulation ---
    await pool.query(
      `
      INSERT INTO packaging_units
        (vegetable, year, units)
      VALUES ($1, $2, $3)

      ON CONFLICT (vegetable, year)
      DO UPDATE SET
        units = packaging_units.units + EXCLUDED.units,
        updated_at = NOW()
      `,
      [vegetable || "AUCUNE", year, units],
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Erreur losses-tracking POST packaging:", error);
    res.status(500).json({
      success: false,
      error: "Erreur serveur",
    });
  }
});

// ➤ GET: read packaging units grouped by vegetable + year
router.get("/packaging", requireRole(["admin"]), async (req, res) => {
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
        units
      FROM packaging_units
      ${where}
      ORDER BY year DESC, vegetable
      `,
      values,
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Erreur losses-tracking GET packaging:", error);
    res.status(500).json({
      success: false,
      error: "Erreur serveur",
    });
  }
});

export default router;
