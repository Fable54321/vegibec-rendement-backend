import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("rendement", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("rendement", ["admin", "user"]);

const inventoryColumns = `
  vegetable_id,
  full_name,
  product_code,
  bought_qty,
  sold_qty,
  in_transit_qty,
  accounting_equivalence,
  product_type,
  format
`;

function parseVegetableId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;

  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647
    ? id
    : null;
}

// PostgreSQL numeric(14, 3): at most 11 digits before the decimal and 3 after it.
function parseQuantity(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;

  const normalized = String(value).trim();
  if (!/^\d{1,11}(?:\.\d{1,3})?$/.test(normalized)) return null;

  return normalized;
}

router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT ${inventoryColumns}
      FROM inventory.produce
      ORDER BY full_name, vegetable_id
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching produce inventory:", error);
    return res.status(500).json({ error: "Failed to fetch inventory" });
  }
});

router.get("/:vegetableId", readRoles, async (req, res) => {
  const vegetableId = parseVegetableId(req.params.vegetableId);
  if (vegetableId === null) {
    return res.status(400).json({ error: "Invalid vegetableId" });
  }

  try {
    const result = await pool.query(
      `SELECT ${inventoryColumns}
       FROM inventory.produce
       WHERE vegetable_id = $1`,
      [vegetableId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching produce inventory item:", error);
    return res.status(500).json({ error: "Failed to fetch inventory item" });
  }
});

router.patch("/:vegetableId", writeRoles, async (req, res) => {
  const vegetableId = parseVegetableId(req.params.vegetableId);
  if (vegetableId === null) {
    return res.status(400).json({ error: "Invalid vegetableId" });
  }

  const allowedFields = ["sold_qty", "in_transit_qty"] as const;
  const providedFields = allowedFields.filter(
    (field) => req.body?.[field] !== undefined,
  );

  if (providedFields.length === 0) {
    return res.status(400).json({
      error: "Provide sold_qty and/or in_transit_qty",
    });
  }

  const values: Array<string | number> = [];
  const assignments: string[] = [];

  for (const field of providedFields) {
    const quantity = parseQuantity(req.body[field]);
    if (quantity === null) {
      return res.status(400).json({
        error: `${field} must be a non-negative number with at most 3 decimal places`,
      });
    }

    values.push(quantity);
    assignments.push(`${field} = $${values.length}`);
  }

  values.push(vegetableId);

  try {
    const result = await pool.query(
      `UPDATE inventory.produce
       SET ${assignments.join(", ")}
       WHERE vegetable_id = $${values.length}
       RETURNING ${inventoryColumns}`,
      values,
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error updating produce inventory:", error);
    return res.status(500).json({ error: "Failed to update inventory" });
  }
});

export default router;
