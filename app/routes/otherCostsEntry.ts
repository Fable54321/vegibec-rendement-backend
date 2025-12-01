import express from "express";
import { pool } from "../db"; // ✅ adjust path if needed

const router = express.Router();

/**
 * POST /api/other-costs-entry
 * Handles:
 *  - SEMENCE  -> seed_costs_new
 *  - PRODUITS DU SOL -> soil_products_costs_new
 *  - EMBALLAGE -> packaging_costs_new
 *  - Everything else -> other_costs_new
 */
router.post("/", async (req, res) => {
  try {
    const { category, amount, vegetable, entryDate } = req.body;

    if (!category || amount === undefined) {
      return res
        .status(400)
        .json({ success: false, message: "Données manquantes" });
    }

    // ✅ If date provided → use it, else use NOW()
    const effectiveDate = entryDate ? new Date(entryDate) : new Date();
    const year = effectiveDate.getFullYear();

    let tableName = "";
    let query = "";
    let values: any[] = [];

    // ✅ CATEGORY → TABLE MAPPING
    if (category === "SEMENCE") {
      tableName = "seed_costs_new";
    } else if (category === "PRODUITS DU SOL") {
      tableName = "soil_products_costs_new";
    } else if (category === "EMBALLAGE") {
      tableName = "packaging_costs_new";
    } else {
      tableName = "other_costs_new";
    }

    // ✅ TABLE WITHOUT VEGETABLE
    if (tableName === "other_costs_new") {
      query = `
        INSERT INTO other_costs_new (total_cost, year, created_at, updated_at)
        VALUES ($1, $2, $3, $3)
        RETURNING id
      `;
      values = [amount, year, effectiveDate];
    }

    // ✅ TABLES WITH VEGETABLE
    else {
      query = `
        INSERT INTO ${tableName} (vegetable, total_cost, year, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        RETURNING id
      `;
      values = [vegetable || "AUCUNE", amount, year, effectiveDate];
    }

    const result = await pool.query(query, values);

    res.json({
      success: true,
      insertedId: result.rows[0].id,
    });
  } catch (error) {
    console.error("Erreur otherCostsEntry:", error);
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

export default router;
