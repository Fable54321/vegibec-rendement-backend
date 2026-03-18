import express from "express";
import { pool } from "../db";
import { requireAppRole } from "../middleware/auth";

const router = express.Router();

// GET seed quantities for loss tracking
router.get(
  "/seeds",
  requireAppRole("rendement", ["admin"]),
  async (req, res) => {
    try {
      const { year, vegetable } = req.query;

      const values: any[] = [];
      const conditions: string[] = [];

      if (year) {
        values.push(year);
        conditions.push(`year = $${values.length}`);
      }

      if (vegetable) {
        values.push(vegetable);
        conditions.push(`vegetable = $${values.length}`);
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // ─── If a vegetable is selected → split per cultivar ───
      const groupBy = vegetable
        ? "year, vegetable, cultivar"
        : "year, vegetable";

      const selectCultivar = vegetable ? "cultivar," : "NULL AS cultivar,";

      const result = await pool.query(
        `
      SELECT
        year,
        vegetable,
        ${selectCultivar}
        SUM(units) AS units
      FROM seed_costs_new
      ${where}
      GROUP BY ${groupBy}
      ORDER BY year DESC, vegetable, cultivar NULLS LAST
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
  },
);

router.post(
  "/packaging",
  requireAppRole("rendement", ["admin"]),
  async (req, res) => {
    try {
      const { vegetable, cultivar, year, units } = req.body;

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

      // Normalize values
      const veg = vegetable.trim().toUpperCase();
      const cult = cultivar ? cultivar.trim().toUpperCase() : null;

      // --- Insert with accumulation (vegetable + cultivar + year) ---
      await pool.query(
        `
      INSERT INTO packaging_units
        (vegetable, cultivar, year, units, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())

      ON CONFLICT (vegetable, cultivar, year)
      DO UPDATE SET
        units = packaging_units.units + EXCLUDED.units,
        updated_at = NOW()
      `,
        [veg || "AUCUNE", cult, year, units],
      );

      res.json({ success: true });
    } catch (error) {
      console.error("Erreur losses-tracking POST packaging:", error);
      res.status(500).json({
        success: false,
        error: "Erreur serveur",
      });
    }
  },
);

// ➤ GET: read packaging units grouped by vegetable + year
router.get(
  "/packaging",
  requireAppRole("rendement", ["admin"]),
  async (req, res) => {
    try {
      const { year, vegetable } = req.query;

      const values: any[] = [];
      const where: string[] = [];

      let groupBy: string;
      let select: string;
      let orderBy: string;

      // ----- Filters -----
      if (year) {
        values.push(year);
        where.push(`year = $${values.length}`);
      }

      if (vegetable) {
        values.push(vegetable);
        where.push(`vegetable = $${values.length}`);

        // ➜ Drill down mode = show per cultivar
        select = `
        year,
        vegetable,
        cultivar,
        SUM(units) AS units
      `;

        groupBy = `GROUP BY year, vegetable, cultivar`;

        orderBy = `ORDER BY year DESC, vegetable, cultivar NULLS LAST`;
      } else {
        // ➜ Global mode = total per vegetable
        select = `
        year,
        vegetable,
        SUM(units) AS units
      `;

        groupBy = `GROUP BY year, vegetable`;

        orderBy = `ORDER BY year DESC, vegetable`;
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const result = await pool.query(
        `
      SELECT
        ${select}
      FROM packaging_units
      ${whereSql}
      ${groupBy}
      ${orderBy}
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
  },
);

export default router;
