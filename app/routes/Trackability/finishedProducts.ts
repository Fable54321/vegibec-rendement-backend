import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("rendement", ["admin", "user", "guest"]);

router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        vegetable_id,
        full_name,
        product_code,
        cup,
        is_active,
        quantity_format,
        product_type,
        qty_per_pallet,
        weight
      FROM public.finished_product
      ORDER BY full_name, id
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching finished products:", error);
    return res.status(500).json({ error: "Failed to fetch finished products" });
  }
});

export default router;
