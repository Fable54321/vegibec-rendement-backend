import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("rendement", ["admin", "user", "guest"]);

router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        fp.id,
        fp.vegetable_id,
        fp.full_name,
        fp.product_code,
        fp.cup,
        fp.is_active,
        fp.quantity_format,
        fp.product_type,
        fp.qty_per_pallet,
        fp.weight,
        ip.on_hand_qty, ip.sold_qty, ip.balance_qty, ip.estimated_pallet_qty
      FROM public.finished_product fp
      LEFT JOIN inventory.produce ip ON ip.produce_id = fp.id
      ORDER BY fp.full_name, fp.id
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching finished products:", error);
    return res.status(500).json({ error: "Failed to fetch finished products" });
  }
});

export default router;
