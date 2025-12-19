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
    const {
      category,
      amount,
      vegetable,
      year,
      cost_domain,
      employee_name,
      description,

      is_seasonal,
    } = req.body;

    const businessDescription = description;

    // Validate required fields
    if (
      !category ||
      amount === undefined ||
      !year ||
      !cost_domain ||
      !employee_name
    ) {
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

    const recordDate = new Date(year, 0, 1); // first day of the year

    const costEntryQuery = `
  INSERT INTO cost_entries
  (category, amount, vegetable, year, cost_domain, employee_name, business_description, description, is_seasonal)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8, $9)
  RETURNING id
`;

    const costEntryValues = [
      category,
      amount,
      vegetable,
      year,
      cost_domain,
      employee_name,
      businessDescription ?? null,
      description ?? null,
      is_seasonal ?? null,
    ];
    const costEntryResult = await pool.query(costEntryQuery, costEntryValues);

    // Update the appropriate table based on cost_domain
    switch (cost_domain) {
      case "SEMENCE":
        await pool.query(
          `
          INSERT INTO seed_costs_new (vegetable, total_cost, year, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$4)
          ON CONFLICT (vegetable, year)
          DO UPDATE SET
            total_cost = seed_costs_new.total_cost + EXCLUDED.total_cost,
            updated_at = EXCLUDED.updated_at
        `,
          [vegetable || "AUCUNE", amount, year, recordDate]
        );
        break;

      case "EMBALLAGE":
        await pool.query(
          `
          INSERT INTO packaging_costs_new (vegetable, total_cost, year, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$4)
          ON CONFLICT (vegetable, year)
          DO UPDATE SET
            total_cost = packaging_costs_new.total_cost + EXCLUDED.total_cost,
            updated_at = EXCLUDED.updated_at
        `,
          [vegetable || "AUCUNE", amount, year, recordDate]
        );
        break;

      case "UNSPECIFIED": {
        const costType = is_seasonal ? "seasonal" : "annual";

        await pool.query(
          `
    INSERT INTO unspecified_costs (
      description,
      amount,
      cost_year,
      cost_type,
      entry_date,
      created_at,
      updated_at,
      vegetable
    )
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), $6)
    RETURNING *
    `,
          [
            description, // $1
            amount, // $2
            year, // $3
            costType, // $4
            recordDate, // $5
            vegetable || null, // $6
          ]
        );

        break;
      }

      default:
        // soil categories or other costs
        const soilCategories = [
          "Chaux calcique",
          "Engrais chimiques",
          "Engrais verts",
          "Fumier",
          "Terre et Terreaux",
        ];

        if (soilCategories.includes(cost_domain)) {
          // soil products cost
          await pool.query(
            `
            INSERT INTO soil_products_costs_new (vegetable, total_cost, year, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$4)
            ON CONFLICT (vegetable, year)
            DO UPDATE SET
              total_cost = soil_products_costs_new.total_cost + EXCLUDED.total_cost,
              updated_at = EXCLUDED.updated_at
          `,
            [vegetable || "AUCUNE", amount, year, recordDate]
          );

          await pool.query(
            `
            INSERT INTO soil_products_category_totals_new (category, total_cost, year, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$4)
            ON CONFLICT (category, year)
            DO UPDATE SET
              total_cost = soil_products_category_totals_new.total_cost + EXCLUDED.total_cost,
              updated_at = EXCLUDED.updated_at
          `,
            [category, amount, year, recordDate]
          );
        } else {
          // generic other costs
          await pool.query(
            `
            INSERT INTO other_costs_new (category, total_cost, year, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$4)
            ON CONFLICT (category, year)
            DO UPDATE SET
              total_cost = other_costs_new.total_cost + EXCLUDED.total_cost,
              updated_at = EXCLUDED.updated_at
          `,
            [category, amount, year, recordDate]
          );
        }
    }

    return res.json({ success: true, costEntryId: costEntryResult.rows[0].id });
  } catch (error) {
    console.error("Erreur otherCostsEntry:", error);
    res.status(500).json({ success: false, error: "Erreur serveur" });
  }
});

export default router;
