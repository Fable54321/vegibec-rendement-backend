import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user", "guest"]);

const columns = `
  id,
  reference_number,
  planting_tracking_id,
  harvest_date,
  harvested_quantity,
  quantity_unit,
  notes,
  created_at
`;

const editableFields = [
  "reference_number",
  "planting_tracking_id",
  "harvest_date",
  "harvested_quantity",
  "quantity_unit",
  "notes",
] as const;

type EditableField = (typeof editableFields)[number];

const requiredFields: EditableField[] = [
  "reference_number",
  "planting_tracking_id",
  "harvest_date",
];

function parsePositiveInteger(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const normalized = String(value).trim();
  return /^\d+$/.test(normalized) && BigInt(normalized) > 0
    ? normalized
    : null;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseQuantity(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const normalized = String(value).trim();
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)
    ? normalized
    : null;
}

function validateField(field: EditableField, value: unknown): string | null {
  if (field === "reference_number") {
    return typeof value === "string" && value.trim().length > 0
      ? null
      : "reference_number must be a non-empty string";
  }

  if (field === "planting_tracking_id") {
    return parsePositiveInteger(value) !== null
      ? null
      : "planting_tracking_id must be a positive integer";
  }

  if (field === "harvest_date") {
    return isDate(value)
      ? null
      : "harvest_date must be a valid date in YYYY-MM-DD format";
  }

  if (field === "harvested_quantity") {
    return value === null || parseQuantity(value) !== null
      ? null
      : "harvested_quantity must be a non-negative number or null";
  }

  return value === null || typeof value === "string"
    ? null
    : `${field} must be a string or null`;
}

function normalizeValue(field: EditableField, value: unknown) {
  if (field === "reference_number" && typeof value === "string") {
    return value.trim();
  }

  if (field === "planting_tracking_id") return parsePositiveInteger(value);
  if (field === "harvested_quantity" && value !== null) {
    return parseQuantity(value);
  }

  return value;
}

function databaseError(
  res: Parameters<Parameters<typeof router.get>[1]>[1],
  error: unknown,
) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";

  if (code === "23505") {
    return res.status(409).json({
      error: "A harvesting tracking record with these values already exists",
    });
  }

  if (code === "23503") {
    return res.status(400).json({
      error: "The referenced planting tracking record does not exist",
    });
  }

  console.error("Harvesting tracking database error:", error);
  return res
    .status(500)
    .json({ error: "Harvesting tracking database operation failed" });
}

router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT ${columns}
      FROM trackability.harvesting_tracking
      ORDER BY harvest_date DESC, id DESC
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    return databaseError(res, error);
  }
});

router.get("/:id", readRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });

  try {
    const result = await pool.query(
      `SELECT ${columns}
       FROM trackability.harvesting_tracking
       WHERE id = $1`,
      [id],
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Harvesting tracking record not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

router.post("/", writeRoles, async (req, res) => {
  for (const field of requiredFields) {
    if (req.body?.[field] === undefined || req.body[field] === null) {
      return res.status(400).json({ error: `${field} is required` });
    }
  }

  const providedFields = editableFields.filter(
    (field) => req.body?.[field] !== undefined,
  );

  for (const field of providedFields) {
    const error = validateField(field, req.body[field]);
    if (error) return res.status(400).json({ error });
  }

  const values = providedFields.map((field) =>
    normalizeValue(field, req.body[field]),
  );
  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");

  try {
    const result = await pool.query(
      `INSERT INTO trackability.harvesting_tracking (${providedFields.join(", ")})
       VALUES (${placeholders})
       RETURNING ${columns}`,
      values,
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

router.patch("/:id", writeRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });

  const providedFields = editableFields.filter(
    (field) => req.body?.[field] !== undefined,
  );
  if (providedFields.length === 0) {
    return res.status(400).json({
      error: "Provide at least one editable field",
    });
  }

  for (const field of providedFields) {
    if (requiredFields.includes(field) && req.body[field] === null) {
      return res.status(400).json({ error: `${field} cannot be null` });
    }

    const error = validateField(field, req.body[field]);
    if (error) return res.status(400).json({ error });
  }

  const values = providedFields.map((field) =>
    normalizeValue(field, req.body[field]),
  );
  const assignments = providedFields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE trackability.harvesting_tracking
       SET ${assignments.join(", ")}
       WHERE id = $${values.length}
       RETURNING ${columns}`,
      values,
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Harvesting tracking record not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

router.delete("/:id", writeRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });

  try {
    const result = await pool.query(
      `DELETE FROM trackability.harvesting_tracking
       WHERE id = $1
       RETURNING ${columns}`,
      [id],
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Harvesting tracking record not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

export default router;
