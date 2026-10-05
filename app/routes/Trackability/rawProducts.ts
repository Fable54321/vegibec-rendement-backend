import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", ["admin", "user", "guest"]);

router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        rp.id,
        rp.vegetable_id,
        rp.product_code,
        rp.cup_label,
        rp.description,
        rp.product_type,
        rp.quantity_format,
        rp.unit_format,
        rp.qty_per_pallet,
        rp.transport_weight,
        rp.is_active
      FROM public.raw_product rp
      ORDER BY fp.full_name, fp.id
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching raw products:", error);
    return res.status(500).json({ error: "Failed to fetch raw products" });
  }
});

export default router;
