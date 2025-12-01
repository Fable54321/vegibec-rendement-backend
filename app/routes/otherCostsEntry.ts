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
  const { category, amount, vegetable } = req.body;

  if (!category || !amount) {
    return res.status(400).json({ error: "Données manquantes" });
  }

  const safeVegetable =
    vegetable && vegetable.trim() !== "" ? vegetable : "AUCUNE";
  const year = new Date().getFullYear();

  let tableName = "other_costs_new";

  if (category === "SEMENCE") tableName = "seed_costs_new";
  else if (category === "PRODUITS DU SOL")
    tableName = "soil_products_costs_new";
  else if (category === "EMBALLAGE") tableName = "packaging_costs_new";

  try {
    // ✅ 1️⃣ Check if this year + vegetable already exists
    const existing = await pool.query(
      `
      SELECT id, total_cost
      FROM ${tableName}
      WHERE year = $1 AND vegetable = $2
      `,
      [year, safeVegetable]
    );

    if (existing.rows.length > 0) {
      // ✅ 2️⃣ UPDATE -> add to existing total
      await pool.query(
        `
        UPDATE ${tableName}
        SET total_cost = total_cost + $1
        WHERE id = $2
        `,
        [amount, existing.rows[0].id]
      );
    } else {
      // ✅ 3️⃣ INSERT new row
      await pool.query(
        `
        INSERT INTO ${tableName} (year, vegetable, total_cost)
        VALUES ($1, $2, $3)
        `,
        [year, safeVegetable, amount]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("POST /other-costs-entry error:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
