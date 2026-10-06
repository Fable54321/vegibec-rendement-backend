import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user", "guest"]);

const columns = `
  id,
  team_leader_user_id,
  subfield,
  harvesting_date,
  harvesting_time,
  vegetable_id,
  product_id,
  amount_of_boxes,
  box_type,
  harvester_id,
  created_at
`;

const editableFields = [
  "team_leader_user_id",
  "subfield",
  "harvesting_date",
  "harvesting_time",
  "vegetable_id",
  "product_id",
  "amount_of_boxes",
  "box_type",
  "harvester_id",
] as const;

type EditableField = (typeof editableFields)[number];

const requiredFields: EditableField[] = [
  "team_leader_user_id",
  "subfield",
  "harvesting_date",
  "harvesting_time",
  "vegetable_id",
  "amount_of_boxes",
  "box_type",
  "harvester_id",
];


function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const normalized = String(value).trim();

  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);

  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}


function isDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}


function isTime(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  return /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
}


function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}


function validateField(
  field: EditableField,
  value: unknown,
): string | null {
 if (field === "team_leader_user_id") {
  return parsePositiveInteger(value) !== null
    ? null
    : "team_leader_user_id must be a positive integer";
}

  if (field === "amount_of_boxes") {
    return parsePositiveInteger(value) !== null
      ? null
      : "amount_of_boxes must be a positive integer";
  }

  if (field === "vegetable_id") {
    return parsePositiveInteger(value) !== null
      ? null
      : "vegetable_id must be a positive integer";
  }

  if (field === "harvesting_date") {
    return isDate(value)
      ? null
      : "harvesting_date must be a valid date in YYYY-MM-DD format";
  }

  if (field === "harvesting_time") {
    return isTime(value)
      ? null
      : "harvesting_time must be a valid time in HH:MM format";
  }

  if (field === "product_id") {
    return value === null || parsePositiveInteger(value) !== null
      ? null
      : "product_id must be a positive integer or null";
  }

  if (field === "harvester_id") {
    return value === null || parsePositiveInteger(value) !== null
      ? null
      : "harvester_id must be a positive integer or null";
  }

  if (
    field === "subfield" ||
    field === "box_type"
  ) {
    return isNonEmptyString(value)
      ? null
      : `${field} must be non-empty `;
  }

  return null;
}


function normalizeValue(
  field: EditableField,
  value: unknown,
) {
  if (
    field === "vegetable_id" ||
    field === "team_leader_user_id" ||
    field === "amount_of_boxes" ||
    field === "product_id" ||
    field === "harvester_id"
  ) {
    return parsePositiveInteger(value);
  }

  if (
    
    field === "box_type"
   
  ) {
    return typeof value === "string"
      ? value.trim()
      : value;
  }

  return value;
}


function databaseError(
  res: Parameters<Parameters<typeof router.get>[1]>[1],
  error: unknown,
) {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error
      ? String(error.code)
      : "";

  if (code === "23505") {
    return res.status(409).json({
      error: "A harvesting tracking record with these values already exists",
    });
  }

  if (code === "23503") {
    return res.status(400).json({
      error: "One of the referenced users or products does not exist",
    });
  }

  if (code === "23502") {
    return res.status(400).json({
      error: "A required harvesting field is missing",
    });
  }

  console.error(
    "Harvesting tracking database error:",
    error,
  );

  return res.status(500).json({
    error: "Harvesting tracking database operation failed",
  });
}




router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT ${columns}
      FROM trackability.harvesting_tracking
      ORDER BY
        harvesting_date DESC,
        harvesting_time DESC,
        id DESC
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    return databaseError(res, error);
  }
});


router.get("/:id", readRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);

  if (id === null) {
    return res.status(400).json({
      error: "Invalid id",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT ${columns}
      FROM trackability.harvesting_tracking
      WHERE id = $1
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Harvesting tracking record not found",
      });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});



router.post("/", writeRoles, async (req, res) => {
  for (const field of requiredFields) {
    if (
      req.body?.[field] === undefined ||
      req.body[field] === null
    ) {
      return res.status(400).json({
        error: `${field} is required`,
      });
    }
  }

  const providedFields = editableFields.filter(
    (field) => req.body?.[field] !== undefined,
  );

  for (const field of providedFields) {
    const error = validateField(
      field,
      req.body[field],
    );

    if (error) {
      return res.status(400).json({
        error,
      });
    }
  }

  const values = providedFields.map((field) =>
    normalizeValue(
      field,
      req.body[field],
    ),
  );

  const placeholders = values
    .map((_, index) => `$${index + 1}`)
    .join(", ");

  try {
    const result = await pool.query(
      `
      INSERT INTO trackability.harvesting_tracking (
        ${providedFields.join(", ")}
      )
      VALUES (${placeholders})
      RETURNING ${columns}
      `,
      values,
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});


router.patch("/:id", writeRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);

  if (id === null) {
    return res.status(400).json({
      error: "Invalid id",
    });
  }

  const providedFields = editableFields.filter(
    (field) => req.body?.[field] !== undefined,
  );

  if (providedFields.length === 0) {
    return res.status(400).json({
      error: "Provide at least one editable field",
    });
  }

  for (const field of providedFields) {
    if (
      requiredFields.includes(field) &&
      req.body[field] === null
    ) {
      return res.status(400).json({
        error: `${field} cannot be null`,
      });
    }

    const error = validateField(
      field,
      req.body[field],
    );

    if (error) {
      return res.status(400).json({
        error,
      });
    }
  }

  const values = providedFields.map((field) =>
    normalizeValue(
      field,
      req.body[field],
    ),
  );

  const assignments = providedFields.map(
    (field, index) =>
      `${field} = $${index + 1}`,
  );

  values.push(id);

  try {
    const result = await pool.query(
      `
      UPDATE trackability.harvesting_tracking
      SET ${assignments.join(", ")}
      WHERE id = $${values.length}
      RETURNING ${columns}
      `,
      values,
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Harvesting tracking record not found",
      });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});


// DELETE

router.delete("/:id", writeRoles, async (req, res) => {
  const id = parsePositiveInteger(req.params.id);

  if (id === null) {
    return res.status(400).json({
      error: "Invalid id",
    });
  }

  try {
    const result = await pool.query(
      `
      DELETE FROM trackability.harvesting_tracking
      WHERE id = $1
      RETURNING ${columns}
      `,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Harvesting tracking record not found",
      });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});


export default router;
