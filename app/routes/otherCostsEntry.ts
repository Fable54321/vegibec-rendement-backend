import express from "express";
import { pool } from "../db"; // ✅ adjust path if needed
import { requireRole } from "../middleware/auth";

const router = express.Router();

/**
 * POST /api/other-costs-entry
 * Handles:
 *  - SEMENCE  -> seed_costs_new
 *  - PRODUITS DU SOL -> soil_products_costs_new + soil_products_category_totals_new
 *  - EMBALLAGE -> packaging_costs_new
 *  - Everything else -> other_costs_new
 */
router.post("/", requireRole(["admin"]), async (req, res) => {
  try {
    const { category, amount, vegetable, year } = req.body;

    if (!category || amount === undefined || !year) {
      return res
        .status(400)
        .json({ success: false, message: "Données manquantes" });
    }

    const currentYear = new Date().getFullYear();
    if (year < 2000 || year > currentYear + 1) {
      return res
        .status(400)
        .json({ success: false, message: "Année invalide" });
    }

    // Use the first day of the specified year for created_at / updated_at
    const recordDate = new Date(year, 0, 1);

    // Soil product categories
    const soilCategories = [
      "Chaux calcique",
      "Engrais chimiques",
      "Engrais verts",
      "Fumier",
      "Terre et Terreaux",
    ];

    if (category === "SEMENCE") {
      const query = `
        INSERT INTO seed_costs_new (vegetable, total_cost, year, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT (vegetable, year)
        DO UPDATE SET
          total_cost = seed_costs_new.total_cost + EXCLUDED.total_cost,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `;
      const values = [vegetable || "AUCUNE", amount, year, recordDate];
      const result = await pool.query(query, values);

      return res.json({ success: true, insertedId: result.rows[0].id });
    } else if (soilCategories.includes(category)) {
      const vegQuery = `
        INSERT INTO soil_products_costs_new (vegetable, total_cost, year, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT (vegetable, year)
        DO UPDATE SET
          total_cost = soil_products_costs_new.total_cost + EXCLUDED.total_cost,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `;
      const vegValues = [vegetable || "AUCUNE", amount, year, recordDate];
      const vegResult = await pool.query(vegQuery, vegValues);

      const catQuery = `
        INSERT INTO soil_products_category_totals_new (category, total_cost, year, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT (category, year)
        DO UPDATE SET
          total_cost = soil_products_category_totals_new.total_cost + EXCLUDED.total_cost,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `;
      const catValues = [category, amount, year, recordDate];
      const catResult = await pool.query(catQuery, catValues);

      return res.json({
        success: true,
        insertedVegetableId: vegResult.rows[0].id,
        insertedCategoryId: catResult.rows[0].id,
      });
    } else if (category === "EMBALLAGE") {
      const query = `
        INSERT INTO packaging_costs_new (vegetable, total_cost, year, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT (vegetable, year)
        DO UPDATE SET
          total_cost = packaging_costs_new.total_cost + EXCLUDED.total_cost,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `;
      const values = [vegetable || "AUCUNE", amount, year, recordDate];
      const result = await pool.query(query, values);

      return res.json({ success: true, insertedId: result.rows[0].id });
    } else {
      const query = `
        INSERT INTO other_costs_new (category, total_cost, year, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT (category, year)
        DO UPDATE SET
          total_cost = other_costs_new.total_cost + EXCLUDED.total_cost,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `;
      const values = [category, amount, year, recordDate];
      const result = await pool.query(query, values);

      return res.json({ success: true, insertedId: result.rows[0].id });
    }
  } catch (error) {
    console.error("Erreur otherCostsEntry:", error);
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

export default router;
