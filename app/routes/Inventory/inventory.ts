import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user", "guest"]);

const inventoryColumns = `
  vegetable_id,
  full_name,
  product_code,
  bought_qty,
  sold_qty,
  in_transit_qty,
  accounting_equivalence,
  product_type,
  format,
  cup,
  site_name,
  on_hand_qty,
  estimated_pallet_qty,
  balance_qty,
  preferred_producer,
  last_cost,
  amount,
  product_group,
  produce_id
`;

const rawProductColumns = `
  id,
  vegetable_id,
  product_code,
  cup_label,
  description,
  product_type,
  quantity_format,
  unit_format,
  product_group,
  qty_per_pallet,
  transport_weight,
  is_active,
  created_at,
  updated_at
`;

const rawProductWritableFields = [
  "vegetable_id",
  "product_code",
  "cup_label",
  "description",
  "product_type",
  "quantity_format",
  "unit_format",
  "product_group",
  "qty_per_pallet",
  "transport_weight",
  "is_active",
] as const;

type RawProductWritableField = (typeof rawProductWritableFields)[number];

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

function parsePositiveBigInt(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;

  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;

  try {
    const parsed = BigInt(normalized);
    return parsed > 0n && parsed <= 9_223_372_036_854_775_807n
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function parseRawProductId(value: string): string | null {
  return parsePositiveBigInt(value);
}

function parseLimitedText(
  value: unknown,
  maxLength: number,
  nullable: boolean,
): string | null | undefined {
  if (value === null && nullable) return null;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    return undefined;
  }

  return normalized;
}

function parseDecimal(
  value: unknown,
  integerDigits: number,
  decimalDigits: number,
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" && typeof value !== "string") return undefined;

  const normalized = String(value).trim();
  const decimalPattern = new RegExp(
    `^\\d{1,${integerDigits}}(?:\\.\\d{1,${decimalDigits}})?$`,
  );

  return decimalPattern.test(normalized) ? normalized : undefined;
}

function parseRawProductField(
  field: RawProductWritableField,
  value: unknown,
): string | number | boolean | null | undefined {
  switch (field) {
    case "vegetable_id":
      return parsePositiveBigInt(value) ?? undefined;
    case "product_code":
    case "product_type":
      return parseLimitedText(value, 50, false);
    case "description":
      return parseLimitedText(value, 255, false);
    case "cup_label":
    case "unit_format":
      return parseLimitedText(value, 50, true);
    case "product_group":
      return parseLimitedText(value, 150, true);
    case "quantity_format":
      return parseDecimal(value, 9, 3);
    case "transport_weight":
      return parseDecimal(value, 10, 2);
    case "qty_per_pallet": {
      if (value === null) return null;
      if (typeof value !== "number" && typeof value !== "string") {
        return undefined;
      }

      const normalized = String(value).trim();
      if (!/^\d+$/.test(normalized)) return undefined;

      const parsed = Number(normalized);
      return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647
        ? parsed
        : undefined;
    }
    case "is_active":
      return typeof value === "boolean" ? value : undefined;
  }
}

function rawProductValidationMessage(field: RawProductWritableField): string {
  switch (field) {
    case "vegetable_id":
      return "vegetable_id must be a positive integer";
    case "product_code":
    case "product_type":
      return `${field} must be a non-empty string of at most 50 characters`;
    case "description":
      return "description must be a non-empty string of at most 255 characters";
    case "cup_label":
    case "unit_format":
      return `${field} must be null or a non-empty string of at most 50 characters`;
    case "product_group":
      return "product_group must be null or a non-empty string of at most 150 characters";
    case "quantity_format":
      return "quantity_format must be null or a non-negative number with at most 3 decimal places";
    case "transport_weight":
      return "transport_weight must be null or a non-negative number with at most 2 decimal places";
    case "qty_per_pallet":
      return "qty_per_pallet must be null or a non-negative 32-bit integer";
    case "is_active":
      return "is_active must be a boolean";
  }
}

function parseRawProductBody(
  body: unknown,
  fields: readonly RawProductWritableField[],
): { values: Array<string | number | boolean | null>; error?: string } {
  const values: Array<string | number | boolean | null> = [];
  const requestBody =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};

  for (const field of fields) {
    const parsed = parseRawProductField(field, requestBody[field]);
    if (parsed === undefined) {
      return { values: [], error: rawProductValidationMessage(field) };
    }
    values.push(parsed);
  }

  return { values };
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

router.get("/products", readRoles, async (_req, res) => {
  try {
    const [produceResult, rawProductResult] = await Promise.all([
      pool.query(`
        SELECT ${inventoryColumns}
        FROM inventory.produce
        ORDER BY full_name, vegetable_id
      `),
      pool.query(`
        SELECT ${rawProductColumns}
        FROM public.raw_product
        ORDER BY description, id
      `),
    ]);

    const products = [
      ...produceResult.rows.map((row) => ({
        ...row,
        inventory_source: "produce" as const,
      })),
      ...rawProductResult.rows.map((row) => ({
        ...row,
        inventory_source: "raw_product" as const,
      })),
    ];

    return res.status(200).json(products);
  } catch (error) {
    console.error("Error fetching combined inventory products:", error);
    return res.status(500).json({ error: "Failed to fetch inventory products" });
  }
});

router.get("/raw-products", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT ${rawProductColumns}
      FROM public.raw_product
      ORDER BY description, id
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching raw products:", error);
    return res.status(500).json({ error: "Failed to fetch raw products" });
  }
});

router.get("/raw-products/:rawProductId", readRoles, async (req, res) => {
  const rawProductId = parseRawProductId(req.params.rawProductId);
  if (rawProductId === null) {
    return res.status(400).json({ error: "Invalid rawProductId" });
  }

  try {
    const result = await pool.query(
      `SELECT ${rawProductColumns}
       FROM public.raw_product
       WHERE id = $1`,
      [rawProductId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Raw product not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching raw product:", error);
    return res.status(500).json({ error: "Failed to fetch raw product" });
  }
});

router.post("/raw-products", writeRoles, async (req, res) => {
  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const requiredFields = [
    "vegetable_id",
    "product_code",
    "description",
  ] as const;
  const missingFields = requiredFields.filter(
    (field) => body[field] === undefined,
  );

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: `Missing required fields: ${missingFields.join(", ")}`,
    });
  }

  const providedFields = rawProductWritableFields.filter(
    (field) => body[field] !== undefined,
  );
  const parsedBody = parseRawProductBody(body, providedFields);
  if (parsedBody.error) {
    return res.status(400).json({ error: parsedBody.error });
  }

  const placeholders = providedFields.map((_, index) => `$${index + 1}`);

  try {
    const result = await pool.query(
      `INSERT INTO public.raw_product (${providedFields.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING ${rawProductColumns}`,
      parsedBody.values,
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating raw product:", error);
    return res.status(500).json({ error: "Failed to create raw product" });
  }
});

router.patch("/raw-products/:rawProductId", writeRoles, async (req, res) => {
  const rawProductId = parseRawProductId(req.params.rawProductId);
  if (rawProductId === null) {
    return res.status(400).json({ error: "Invalid rawProductId" });
  }

  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const providedFields = rawProductWritableFields.filter(
    (field) => body[field] !== undefined,
  );

  if (providedFields.length === 0) {
    return res.status(400).json({
      error: `Provide at least one of: ${rawProductWritableFields.join(", ")}`,
    });
  }

  const parsedBody = parseRawProductBody(body, providedFields);
  if (parsedBody.error) {
    return res.status(400).json({ error: parsedBody.error });
  }

  const assignments = providedFields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  const values = [...parsedBody.values, rawProductId];

  try {
    const result = await pool.query(
      `UPDATE public.raw_product
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING ${rawProductColumns}`,
      values,
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Raw product not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error updating raw product:", error);
    return res.status(500).json({ error: "Failed to update raw product" });
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
