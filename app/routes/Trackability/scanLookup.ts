import { Router } from "express";

import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const readRoles = requireAppRole("main", ["admin", "user", "guest"]);

router.get("/:lotNumber", readRoles, async (req, res) => {
  const lotNumber = req.params.lotNumber.trim();
  const isNumericLot = /^\d{1,19}$/.test(lotNumber);
  const numericLot = isNumericLot ? BigInt(lotNumber) : null;

  if (
    numericLot === null ||
    numericLot <= 0n ||
    numericLot > 9_223_372_036_854_775_807n
  ) {
    return res.status(400).json({
      error: "lotNumber must be a positive numeric lot number",
    });
  }

  const harvestLotNumber =
    numericLot.toString() === lotNumber ? lotNumber : null;

  try {
    const result = await pool.query<{
      lot_number: string;
      product_code: string;
      product_name: string;
      product_source: "raw_product" | "finished_product";
      lot_source: "harvesting_tracking" | "production_outputs";
    }>(
      `
      WITH lot_matches AS (
        SELECT DISTINCT
          h.harvest_lot_number::text AS lot_number,
          COALESCE(rp.product_code::text, fp.product_code::text) AS product_code,
          COALESCE(rp.description::text, fp.full_name::text) AS product_name,
          CASE
            WHEN pr.raw_product_id IS NOT NULL THEN 'raw_product'
            ELSE 'finished_product'
          END AS product_source,
          'harvesting_tracking'::text AS lot_source
        FROM trackability.harvesting_tracking h
        JOIN trackability.product_reference pr
          ON pr.id = h.product_id
        LEFT JOIN public.raw_product rp
          ON rp.id = pr.raw_product_id
        LEFT JOIN public.finished_product fp
          ON fp.id = pr.finished_product_id
        WHERE h.harvest_lot_number = $2::bigint
          AND (pr.raw_product_id IS NULL) <> (pr.finished_product_id IS NULL)

        UNION ALL

        SELECT DISTINCT
          o.output_lot_number::text AS lot_number,
          COALESCE(rp.product_code::text, fp.product_code::text) AS product_code,
          COALESCE(rp.description::text, fp.full_name::text) AS product_name,
          CASE
            WHEN o.raw_product_id IS NOT NULL THEN 'raw_product'
            ELSE 'finished_product'
          END AS product_source,
          'production_outputs'::text AS lot_source
        FROM trackability.production_outputs o
        LEFT JOIN public.raw_product rp
          ON rp.id = o.raw_product_id
        LEFT JOIN public.finished_product fp
          ON fp.id = o.finished_product_id
        WHERE o.output_lot_number::text = $1
          AND (o.raw_product_id IS NULL) <> (o.finished_product_id IS NULL)
      )
      SELECT
        lot_number,
        product_code,
        product_name,
        product_source,
        lot_source
      FROM lot_matches
      `,
      [lotNumber, harvestLotNumber],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Lot number not found" });
    }

    if (result.rows.length > 1) {
      return res.status(409).json({
        error: "Lot number is associated with more than one product",
      });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Scan lookup database error:", error);
    return res.status(500).json({ error: "Failed to look up lot number" });
  }
});

export default router;
