import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("rendement", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("rendement", ["admin", "user"]);

const columns = `
  id,
  reference_number,
  vegetable,
  cultivar,
  seedling_out_date,
  quantity,
  quantity_unit,
  notes,
  created_at
`;

const editableFields = [
  "reference_number",
  "vegetable",
  "cultivar",
  "seedling_out_date",
  "quantity",
  "quantity_unit",
  "notes",
] as const;

type EditableField = (typeof editableFields)[number];

const plantingColumns = `
  id,
  reference_number,
  seedling_tracking_id,
  field_id,
  field_parcel_id,
  planting_date,
  quantity_planted,
  quantity_unit,
  notes,
  created_at
`;

const plantingEditableFields = [
  "reference_number",
  "seedling_tracking_id",
  "field_id",
  "field_parcel_id",
  "planting_date",
  "quantity_planted",
  "quantity_unit",
  "notes",
] as const;

type PlantingEditableField = (typeof plantingEditableFields)[number];

function parseId(value: string): string | null {
  return /^\d+$/.test(value) && BigInt(value) > 0 ? value : null;
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
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) ? normalized : null;
}

function parsePositiveInteger(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const normalized = String(value).trim();
  return /^\d+$/.test(normalized) && BigInt(normalized) > 0 ? normalized : null;
}

function validatePlantingField(field: PlantingEditableField, value: unknown): string | null {
  if (field === "reference_number") {
    return typeof value === "string" && value.trim().length > 0
      ? null
      : "reference_number must be a non-empty string";
  }

  if (field === "field_id") {
    return typeof value === "string" && value.trim().length > 0
      ? null
      : "field_id must be a non-empty field name";
  }

  if (["seedling_tracking_id", "field_parcel_id"].includes(field)) {
    return value === null || parsePositiveInteger(value) !== null
      ? null
      : `${field} must be a positive integer or null`;
  }

  if (field === "planting_date") {
    return isDate(value)
      ? null
      : "planting_date must be a valid date in YYYY-MM-DD format";
  }

  if (field === "quantity_planted") {
    return value === null || parseQuantity(value) !== null
      ? null
      : "quantity_planted must be a non-negative number";
  }

  return value === null || typeof value === "string"
    ? null
    : `${field} must be a string or null`;
}

function normalizePlantingValue(field: PlantingEditableField, value: unknown) {
  if (field === "quantity_planted" && value !== null) return parseQuantity(value);
  if (field === "field_id" && typeof value === "string") return value.trim();
  if (["seedling_tracking_id", "field_parcel_id"].includes(field) && value !== null) {
    return parsePositiveInteger(value);
  }
  if (field === "reference_number" && typeof value === "string") return value.trim();
  return value;
}

function plantingDatabaseError(res: Parameters<Parameters<typeof router.get>[1]>[1], error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";

  if (code === "23505") {
    return res.status(409).json({ error: "A planting tracking record with these values already exists" });
  }

  if (code === "23503") {
    return res.status(400).json({ error: "A referenced seedling, field, or field parcel does not exist" });
  }

  console.error("Planting tracking database error:", error);
  return res.status(500).json({ error: "Planting tracking database operation failed" });
}

function validateField(field: EditableField, value: unknown): string | null {
  if (["reference_number", "vegetable"].includes(field)) {
    return typeof value === "string" && value.trim().length > 0
      ? null
      : `${field} must be a non-empty string`;
  }

  if (field === "seedling_out_date") {
    return isDate(value)
      ? null
      : "seedling_out_date must be a valid date in YYYY-MM-DD format";
  }

  if (field === "quantity") {
    return value === null || parseQuantity(value) !== null
      ? null
      : "quantity must be a non-negative number";
  }

  return value === null || typeof value === "string"
    ? null
    : `${field} must be a string or null`;
}

function databaseError(res: Parameters<Parameters<typeof router.get>[1]>[1], error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";

  if (code === "23505") {
    return res.status(409).json({ error: "A seedling tracking record with these values already exists" });
  }

  console.error("Seedling tracking database error:", error);
  return res.status(500).json({ error: "Seedling tracking database operation failed" });
}

router.get("/planting", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT ${plantingColumns}
      FROM trackability.planting_tracking
      ORDER BY planting_date DESC, id DESC
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    return plantingDatabaseError(res, error);
  }
});

router.get("/planting/:id", readRoles, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });

  try {
    const result = await pool.query(
      `SELECT ${plantingColumns}
       FROM trackability.planting_tracking
       WHERE id = $1`,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Planting tracking record not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return plantingDatabaseError(res, error);
  }
});

router.post("/planting", writeRoles, async (req, res) => {
  req.body = {
    ...req.body,
    planting_date: req.body?.planting_date ?? new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  };

  const requiredFields: PlantingEditableField[] = [
    "reference_number",
    "seedling_tracking_id",
    "field_id",
    "planting_date",
  ];

  for (const field of requiredFields) {
    if (req.body?.[field] === undefined || req.body[field] === null) {
      return res.status(400).json({ error: `${field} is required` });
    }
  }

  const providedFields = plantingEditableFields.filter(
    (field) => req.body?.[field] !== undefined,
  );

  for (const field of providedFields) {
    const error = validatePlantingField(field, req.body[field]);
    if (error) return res.status(400).json({ error });
  }

  const values = providedFields.map((field) => normalizePlantingValue(field, req.body[field]));
  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");

  try {
    const result = await pool.query(
      `INSERT INTO trackability.planting_tracking (${providedFields.join(", ")})
       VALUES (${placeholders})
       RETURNING ${plantingColumns}`,
      values,
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return plantingDatabaseError(res, error);
  }
});

router.patch("/planting/:id", writeRoles, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });

  const providedFields = plantingEditableFields.filter(
    (field) => req.body?.[field] !== undefined,
  );
  if (providedFields.length === 0) {
    return res.status(400).json({ error: "Provide at least one editable field" });
  }

  for (const field of providedFields) {
    if (["reference_number", "seedling_tracking_id", "field_id", "planting_date"].includes(field) && req.body[field] === null) {
      return res.status(400).json({ error: `${field} cannot be null` });
    }

    const error = validatePlantingField(field, req.body[field]);
    if (error) return res.status(400).json({ error });
  }

  const values = providedFields.map((field) => normalizePlantingValue(field, req.body[field]));
  const assignments = providedFields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE trackability.planting_tracking
       SET ${assignments.join(", ")}
       WHERE id = $${values.length}
       RETURNING ${plantingColumns}`,
      values,
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Planting tracking record not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return plantingDatabaseError(res, error);
  }
});

router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT ${columns}
      FROM trackability.seedling_tracking
      ORDER BY seedling_out_date DESC, id DESC
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    return databaseError(res, error);
  }
});

router.get("/:id", readRoles, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });

  try {
    const result = await pool.query(
      `SELECT ${columns}
       FROM trackability.seedling_tracking
       WHERE id = $1`,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Seedling tracking record not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

router.post("/", writeRoles, async (req, res) => {
  const requiredFields: EditableField[] = [
    "reference_number",
    "vegetable",
    "seedling_out_date",
  ];

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

  const values = providedFields.map((field) => {
    const value = req.body[field];
    if (field === "quantity" && value !== null) return parseQuantity(value);
    if (["reference_number", "vegetable"].includes(field)) return value.trim();
    return value;
  });
  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");

  try {
    const result = await pool.query(
      `INSERT INTO trackability.seedling_tracking (${providedFields.join(", ")})
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
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });

  const providedFields = editableFields.filter(
    (field) => req.body?.[field] !== undefined,
  );
  if (providedFields.length === 0) {
    return res.status(400).json({ error: "Provide at least one editable field" });
  }

  for (const field of providedFields) {
    if (["reference_number", "vegetable", "seedling_out_date"].includes(field) && req.body[field] === null) {
      return res.status(400).json({ error: `${field} cannot be null` });
    }

    const error = validateField(field, req.body[field]);
    if (error) return res.status(400).json({ error });
  }

  const values = providedFields.map((field) => {
    const value = req.body[field];
    if (field === "quantity" && value !== null) return parseQuantity(value);
    if (["reference_number", "vegetable"].includes(field)) return value.trim();
    return value;
  });
  const assignments = providedFields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE trackability.seedling_tracking
       SET ${assignments.join(", ")}
       WHERE id = $${values.length}
       RETURNING ${columns}`,
      values,
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Seedling tracking record not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

export default router;
