import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user", "guest"]);

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

function parsePositiveBigInt(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;

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

router.get("/combined", readRoles, async (_req, res) => {
  try {
    const [finishedProductResult, rawProductResult] = await Promise.all([
      pool.query(`
        SELECT
          product_reference.id,
          finished_product.id AS source_product_id,
          finished_product.vegetable_id,
          finished_product.full_name,
          finished_product.product_code,
          finished_product.cup,
          finished_product.is_active,
          finished_product.quantity_format,
          finished_product.product_type,
          finished_product.qty_per_pallet,
          finished_product.stacking_possibility,
          finished_product.weight
        FROM public.finished_product
        INNER JOIN trackability.product_reference
          ON product_reference.finished_product_id = finished_product.id
        ORDER BY finished_product.full_name, finished_product.id
      `),
      pool.query(`
        SELECT
          product_reference.id,
          raw_product.id AS source_product_id,
          raw_product.vegetable_id,
          raw_product.product_code,
          raw_product.cup_label,
          raw_product.description,
          raw_product.product_type,
          raw_product.quantity_format,
          raw_product.unit_format,
          raw_product.product_group,
          raw_product.qty_per_pallet,
          raw_product.transport_weight,
          raw_product.is_active,
          raw_product.created_at,
          raw_product.updated_at
        FROM public.raw_product
        INNER JOIN trackability.product_reference
          ON product_reference.raw_product_id = raw_product.id
        ORDER BY raw_product.description, raw_product.id
      `),
    ]);

    const products = [
      ...finishedProductResult.rows.map((row) => ({
        ...row,
        product_source: "finished_product" as const,
      })),
      ...rawProductResult.rows.map((row) => ({
        ...row,
        product_source: "raw_product" as const,
      })),
    ];

    return res.status(200).json(products);
  } catch (error) {
    console.error("Error fetching combined products:", error);
    return res.status(500).json({ error: "Failed to fetch combined products" });
  }
});

router.get("/:rawProductId", readRoles, async (req, res) => {
  const rawProductId = parsePositiveBigInt(req.params.rawProductId);
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

router.post("/", writeRoles, async (req, res) => {
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

router.patch("/:rawProductId", writeRoles, async (req, res) => {
  const rawProductId = parsePositiveBigInt(req.params.rawProductId);
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

export default router;
