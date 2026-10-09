import { Response, Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user", "guest"]);

const genericPlanColumns = `
  id,
  vegetable_id_1,
  vegetable_id_2,
  acre_superficy,
  hectare_superficy,
  field_id
`;

const writableFields = [
  "vegetable_id_1",
  "vegetable_id_2",
  "acre_superficy",
  "hectare_superficy",
  "field_id",
] as const;

type WritableField = (typeof writableFields)[number];
type ParsedValue = number | string | null;

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

function parseNullableSuperficy(value: unknown): string | null | undefined {
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
    case "vegetable_id_1":
    case "vegetable_id_2":
    case "field_id":
      return parseNullablePositiveInteger(value);
    case "acre_superficy":
    case "hectare_superficy":
      return parseNullableSuperficy(value);
  }
}

function validationMessage(field: WritableField): string {
  switch (field) {
    case "vegetable_id_1":
    case "vegetable_id_2":
    case "field_id":
      return `${field} must be null or a positive 32-bit integer`;
    case "acre_superficy":
    case "hectare_superficy":
      return `${field} must be null or a non-negative number with at most 10 integer digits and 2 decimal places`;
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
      error: "One of the referenced vegetables or fields does not exist",
    });
  }

  if (code === "23505") {
    return res.status(409).json({
      error: "This generic production plan already exists",
    });
  }

  if (["22001", "22003", "23502", "23514"].includes(code)) {
    return res.status(400).json({ error: "Invalid generic production plan data" });
  }

  console.error("Generic production plan database error:", error);
  return res.status(500).json({
    error: "Generic production plan database operation failed",
  });
}

router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT ${genericPlanColumns}
      FROM trackability.generic_production_plan
      ORDER BY id DESC
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
      `SELECT ${genericPlanColumns}
       FROM trackability.generic_production_plan
       WHERE id = $1`,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Generic production plan not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return handleDatabaseError(res, error);
  }
});

router.post("/", writeRoles, async (req, res) => {
  const body = getRequestBody(req.body);
  const providedFields = writableFields.filter(
    (field) => body[field] !== undefined,
  );

  if (providedFields.length === 0) {
    return res.status(400).json({
      error: `Provide at least one of: ${writableFields.join(", ")}`,
    });
  }

  const parsed = parseFields(body, providedFields);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const placeholders = providedFields.map((_, index) => `$${index + 1}`);

  try {
    const result = await pool.query(
      `INSERT INTO trackability.generic_production_plan (${providedFields.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING ${genericPlanColumns}`,
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
      `UPDATE trackability.generic_production_plan
       SET ${assignments.join(", ")}
       WHERE id = $${values.length}
       RETURNING ${genericPlanColumns}`,
      values,
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Generic production plan not found" });
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
      `DELETE FROM trackability.generic_production_plan
       WHERE id = $1
       RETURNING ${genericPlanColumns}`,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Generic production plan not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    const code = getDatabaseErrorCode(error);
    if (code === "23503") {
      return res.status(409).json({
        error: "This generic production plan is referenced by another record and cannot be deleted",
      });
    }

    return handleDatabaseError(res, error);
  }
});

export default router;
