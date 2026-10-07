import { Response, Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user", "guest"]);

const cropPlanColumns = `
  id,
  season,
  responsible,
  culture_id,
  planned_product_id,
  cultivar_id,
  planting_type,
  seeding_number,
  expected_harvest_date,
  field_id,
  planned_area,
  area_unit,
  bed_start,
  bed_end,
  notes,
  created_at,
  updated_at,
  user_id
`;

const writableFields = [
  "season",
  "responsible",
  "culture_id",
  "planned_product_id",
  "cultivar_id",
  "planting_type",
  "seeding_number",
  "expected_harvest_date",
  "field_id",
  "planned_area",
  "area_unit",
  "bed_start",
  "bed_end",
  "notes",
  "user_id",
] as const;

type WritableField = (typeof writableFields)[number];
type ParsedValue = string | number | null;

const requiredFields: readonly WritableField[] = [
  "season",
  "culture_id",
  "planting_type",
];

function getRequestBody(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : {};
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }

  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return undefined;

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647
    ? parsed
    : undefined;
}

function parseNullablePositiveInteger(
  value: unknown,
): number | null | undefined {
  if (value === null || value === "") return null;
  return parsePositiveInteger(value);
}

function parseDate(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function parseRequiredText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : undefined;
}

function parseNullableText(
  value: unknown,
  maxLength?: number,
): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (maxLength !== undefined && normalized.length > maxLength) {
    return undefined;
  }

  return normalized;
}

function parsePlannedArea(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }

  const normalized = String(value).trim();
  return /^\d{1,10}(?:\.\d{1,2})?$/.test(normalized)
    ? normalized
    : undefined;
}

function parseField(
  field: WritableField,
  value: unknown,
): ParsedValue | undefined {
  switch (field) {
    case "season":
    case "culture_id":
      return parsePositiveInteger(value);
    case "planned_product_id":
    case "cultivar_id":
    case "seeding_number":
    case "field_id":
      return parseNullablePositiveInteger(value);
    case "planting_type":
      return parseRequiredText(value, 30);
    case "expected_harvest_date":
      return parseDate(value);
    case "planned_area":
      return parsePlannedArea(value);
    case "area_unit":
    case "bed_start":
    case "bed_end":
      return parseNullableText(value, 20);
    case "notes":
    case "responsible":
      return parseNullableText(value);
    case "user_id":
      return parsePositiveInteger(value);
  }
}

function validationMessage(field: WritableField): string {
  switch (field) {
    case "season":
    case "culture_id":
      return `${field} must be a positive 32-bit integer`;
    case "planned_product_id":
    case "cultivar_id":
    case "seeding_number":
    case "field_id":
      return `${field} must be null or a positive 32-bit integer`;
    case "planting_type":
      return "planting_type must be a non-empty string of at most 30 characters";
    case "expected_harvest_date":
      return "expected_harvest_date must be null or a valid YYYY-MM-DD date";
    case "planned_area":
      return "planned_area must be null or a non-negative number with at most 10 integer digits and 2 decimal places";
    case "area_unit":
    case "bed_start":
    case "bed_end":
      return `${field} must be null or a string of at most 20 characters`;
    case "notes":
      return "notes must be null or a string";
    case "responsible":
      return "responsible must be null or a string";
    case "user_id":
      return "user_id must be a positive integer";  
  }
}

function parseFields(
  body: Record<string, unknown>,
  fields: readonly WritableField[],
): { values: ParsedValue[]; error?: string } {
  const values: ParsedValue[] = [];

  for (const field of fields) {
    const value = parseField(field, body[field]);
    if (value === undefined) {
      return { values: [], error: validationMessage(field) };
    }
    values.push(value);
  }

  return { values };
}

function getDatabaseErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}

function handleDatabaseError(res: Response, error: unknown) {
  const code = getDatabaseErrorCode(error);

  if (code === "23503") {
    return res.status(400).json({
      error: "One of the referenced users, vegetables, cultivars, or fields does not exist",
    });
  }

  if (code === "23505") {
    return res.status(409).json({ error: "This crop plan already exists" });
  }

  if (["22001", "22003", "23502", "23514"].includes(code)) {
    return res.status(400).json({ error: "Invalid crop plan data" });
  }

  console.error("Crop plan database error:", error);
  return res.status(500).json({ error: "Crop plan database operation failed" });
}

router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT ${cropPlanColumns}
      FROM trackability.crop_plans
      ORDER BY season DESC, expected_harvest_date ASC NULLS LAST, id DESC
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    return handleDatabaseError(res, error);
  }
});

router.get("/:id", readRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (id === undefined) {
    return res.status(400).json({ error: "Invalid id" });
  }

  try {
    const result = await pool.query(
      `SELECT ${cropPlanColumns}
       FROM trackability.crop_plans
       WHERE id = $1`,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Crop plan not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return handleDatabaseError(res, error);
  }
});

router.post("/", writeRoles, async (req, res) => {
  const body = getRequestBody(req.body);
  const missingFields = requiredFields.filter(
    (field) => body[field] === undefined || body[field] === null,
  );

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: `Missing required fields: ${missingFields.join(", ")}`,
    });
  }

  const providedFields = writableFields.filter(
    (field) => body[field] !== undefined,
  );
  const parsed = parseFields(body, providedFields);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const placeholders = providedFields.map((_, index) => `$${index + 1}`);

  try {
    const result = await pool.query(
      `INSERT INTO trackability.crop_plans (${providedFields.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING ${cropPlanColumns}`,
      parsed.values,
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return handleDatabaseError(res, error);
  }
});

router.patch("/:id", writeRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (id === undefined) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const body = getRequestBody(req.body);
  const providedFields = writableFields.filter(
    (field) => body[field] !== undefined,
  );

  if (providedFields.length === 0) {
    return res.status(400).json({
      error: `Provide at least one of: ${writableFields.join(", ")}`,
    });
  }

  const nulledRequiredField = requiredFields.find(
    (field) => body[field] === null,
  );
  if (nulledRequiredField) {
    return res.status(400).json({
      error: `${nulledRequiredField} cannot be null`,
    });
  }

  const parsed = parseFields(body, providedFields);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const assignments = providedFields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  const values = [...parsed.values, id];

  try {
    const result = await pool.query(
      `UPDATE trackability.crop_plans
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING ${cropPlanColumns}`,
      values,
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Crop plan not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return handleDatabaseError(res, error);
  }
});

router.delete("/:id", writeRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (id === undefined) {
    return res.status(400).json({ error: "Invalid id" });
  }

  try {
    const result = await pool.query(
      `DELETE FROM trackability.crop_plans
       WHERE id = $1
       RETURNING ${cropPlanColumns}`,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Crop plan not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    const code = getDatabaseErrorCode(error);
    if (code === "23503") {
      return res.status(409).json({
        error: "This crop plan is referenced by another record and cannot be deleted",
      });
    }

    return handleDatabaseError(res, error);
  }
});

export default router;
