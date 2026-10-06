import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user", "guest"]);

const columns = `
  id,
  harvester_number,
  harvester_name
`;

const editableFields = ["harvester_number", "harvester_name"] as const;
type EditableField = (typeof editableFields)[number];

function parseHarvesterId(value: string): string | null {
  if (!/^\d+$/.test(value)) return null;

  try {
    const id = BigInt(value);
    return id > 0n && id <= 9_223_372_036_854_775_807n
      ? id.toString()
      : null;
  } catch {
    return null;
  }
}

function normalizeField(
  field: EditableField,
  value: unknown,
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim();
  if (normalized.length === 0) return null;

  if (field === "harvester_name" && normalized.length > 255) {
    return undefined;
  }

  return normalized;
}

function validationMessage(field: EditableField): string {
  return field === "harvester_name"
    ? "harvester_name must be null or a string of at most 255 characters"
    : "harvester_number must be null or a string";
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
      error: "A harvester with this harvester_number already exists",
    });
  }

  console.error("Harvester database error:", error);
  return res.status(500).json({ error: "Harvester database operation failed" });
}

router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT ${columns}
      FROM equipment.harvesters
      ORDER BY harvester_number NULLS LAST, harvester_name NULLS LAST, id
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    return databaseError(res, error);
  }
});

router.get("/:id", readRoles, async (req, res) => {
  const id = parseHarvesterId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid harvester id" });
  }

  try {
    const result = await pool.query(
      `SELECT ${columns}
       FROM equipment.harvesters
       WHERE id = $1`,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Harvester not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

router.post("/", writeRoles, async (req, res) => {
  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const providedFields = editableFields.filter(
    (field) => body[field] !== undefined,
  );

  if (providedFields.length === 0) {
    return res.status(400).json({
      error: "Provide harvester_number and/or harvester_name",
    });
  }

  const values: Array<string | null> = [];
  for (const field of providedFields) {
    const value = normalizeField(field, body[field]);
    if (value === undefined) {
      return res.status(400).json({ error: validationMessage(field) });
    }
    values.push(value);
  }

  const placeholders = providedFields.map((_, index) => `$${index + 1}`);

  try {
    const result = await pool.query(
      `INSERT INTO equipment.harvesters (${providedFields.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING ${columns}`,
      values,
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

router.patch("/:id", writeRoles, async (req, res) => {
  const id = parseHarvesterId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid harvester id" });
  }

  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const providedFields = editableFields.filter(
    (field) => body[field] !== undefined,
  );

  if (providedFields.length === 0) {
    return res.status(400).json({
      error: "Provide harvester_number and/or harvester_name",
    });
  }

  const values: Array<string | null> = [];
  for (const field of providedFields) {
    const value = normalizeField(field, body[field]);
    if (value === undefined) {
      return res.status(400).json({ error: validationMessage(field) });
    }
    values.push(value);
  }

  const assignments = providedFields.map(
    (field, index) => `${field} = $${index + 1}`,
  );
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE equipment.harvesters
       SET ${assignments.join(", ")}
       WHERE id = $${values.length}
       RETURNING ${columns}`,
      values,
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Harvester not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

router.delete("/:id", writeRoles, async (req, res) => {
  const id = parseHarvesterId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid harvester id" });
  }

  try {
    const result = await pool.query(
      `DELETE FROM equipment.harvesters
       WHERE id = $1
       RETURNING ${columns}`,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Harvester not found" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

export default router;
