import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", [
  "admin",
  "user",
  "guest",
]);

router.get("/:lotNumber", readRoles, async (req, res) => {
  const lotNumber = req.params.lotNumber.trim();

  if (
    lotNumber.length === 0 ||
    lotNumber.length > 50
  ) {
    return res.status(400).json({
      error: "Invalid lot number",
    });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        lb.lot_id::text AS lot_id,
        lb.lot_number,
        lb.lot_type,

        lb.product_id AS product_reference_id,

        COALESCE(
          rp.product_code::text,
          fp.product_code::text
        ) AS product_code,

        COALESCE(
          rp.description,
          fp.full_name
        ) AS product_name,

        CASE
          WHEN lb.raw_product_id IS NOT NULL
            THEN 'raw_product'
          ELSE 'finished_product'
        END AS product_source,

        CASE
          WHEN lb.lot_type = 'harvest'
            THEN 'harvesting_tracking'
          ELSE 'production_outputs'
        END AS lot_source,

        COALESCE(
          rp.qty_per_pallet,
          fp.qty_per_pallet
        ) AS qty_per_pallet,

        lb.available_boxes,

        lb.reserved_boxes,

        (lb.total_boxes - lb.used_boxes)
          AS remaining_boxes

      FROM trackability.lot_balances lb

      LEFT JOIN public.raw_product rp
        ON rp.id = lb.raw_product_id

      LEFT JOIN public.finished_product fp
        ON fp.id = lb.finished_product_id

      WHERE lb.lot_number = $1
      `,
      [lotNumber],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Lot number not found",
      });
    }

    return res.status(200).json(rows[0]);

  } catch (error) {
    console.error(
      "Scan lookup database error:",
      error,
    );

    return res.status(500).json({
      error: "Failed to look up lot number",
    });
  }
});

export default router;
