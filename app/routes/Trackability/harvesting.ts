import { Router, type Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("recolte", ["admin", "user", "guest"]);

// =====================================================
// SELECT
// =====================================================

const columns = `
  h.id,
  h.team_leader_user_id,
  h.field_id,
  h.harvesting_date,
  h.harvesting_time,
  h.vegetable_id,

  h.lot_id,
  l.lot_number AS harvest_lot_number,
  l.product_id,
  l.product_id AS product_reference_id,

  pr.raw_product_id,
  pr.finished_product_id,

  CASE
    WHEN pr.raw_product_id IS NOT NULL THEN 'raw_product'
    WHEN pr.finished_product_id IS NOT NULL THEN 'finished_product'
  END AS product_source,

  COALESCE(
    pr.raw_product_id,
    pr.finished_product_id
  ) AS source_product_id,

  h.amount_of_boxes,
  h.box_type_id,
  h.harvester_id,
  h.created_at,
  h.status,
  h.finalized_at,
  h.received_at
`;

const baseQuery = `
  SELECT ${columns}

  FROM trackability.harvesting_tracking h

  JOIN trackability.lots l
    ON l.id = h.lot_id

  JOIN trackability.product_reference pr
    ON pr.id = l.product_id
`;

// =====================================================
// EDITABLE FIELDS
// =====================================================

const editableFields = [
  "team_leader_user_id",
  "field_id",
  "harvesting_date",
  "harvesting_time",
  "vegetable_id",
  "product_id",
  "amount_of_boxes",
  "box_type_id",
  "harvester_id",
  "harvest_lot_number",
] as const;

type EditableField = (typeof editableFields)[number];

const requiredFields: readonly EditableField[] = [
  "team_leader_user_id",
  "field_id",
  "harvesting_date",
  "harvesting_time",
  "vegetable_id",
  "product_id",
  "amount_of_boxes",
  "box_type_id",
  "harvester_id",
  "harvest_lot_number",
];

// Fields physically stored inside harvesting_tracking.
const directFields = editableFields.filter(
  (field) =>
    field !== "product_id" &&
    field !== "harvest_lot_number",
);

// =====================================================
// ERROR HANDLING
// =====================================================

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function databaseError(res: Response, error: unknown) {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({
      error: error.message,
    });
  }

  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error
      ? String(error.code)
      : "";

  if (code === "23505") {
    return res.status(409).json({
      error: "A record with these values already exists",
    });
  }

  if (code === "23503") {
    return res.status(409).json({
      error:
        "A referenced record does not exist or this record is still being used",
    });
  }

  if (code === "23502") {
    return res.status(400).json({
      error: "A required harvesting field is missing",
    });
  }

  if (
    code === "23514" ||
    code === "22003" ||
    code === "22001" ||
    code === "22P02"
  ) {
    return res.status(400).json({
      error: "One or more harvesting values are invalid",
    });
  }

  // Business rule exception raised by PostgreSQL functions
  // or triggers.
  if (code === "P0001") {
    return res.status(409).json({
      error:
        error instanceof Error
          ? error.message
          : "Harvesting operation is not permitted",
    });
  }

  if (code === "40001" || code === "40P01") {
    return res.status(409).json({
      error: "Concurrent database operation. Please retry.",
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

// =====================================================
// VALIDATION HELPERS
// =====================================================

function parsePositiveInteger(
  value: unknown,
): number | null {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return null;
  }

  const normalized = String(value).trim();

  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);

  return Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= 2147483647
    ? parsed
    : null;
}

// Harvesting IDs and lot IDs are PostgreSQL BIGINT.
// Keep them as strings to avoid JavaScript precision loss.
function parseBigIntId(value: unknown): string | null {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return null;
  }

  if (
    typeof value === "number" &&
    !Number.isSafeInteger(value)
  ) {
    return null;
  }

  const normalized = String(value).trim();

  if (!/^[1-9]\d*$/.test(normalized)) {
    return null;
  }

  if (normalized.length > 19) {
    return null;
  }

  try {
    const parsed = BigInt(normalized);

    if (parsed > BigInt("9223372036854775807")) {
      return null;
    }

    return normalized;
  } catch {
    return null;
  }
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
  return (
    typeof value === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)
  );
}

function isValidLotNumber(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 50
  );
}

function validateField(
  field: EditableField,
  value: unknown,
): string | null {
  switch (field) {
    case "team_leader_user_id":
    case "field_id":
    case "vegetable_id":
    case "product_id":
    case "amount_of_boxes":
    case "box_type_id":
    case "harvester_id":
      return parsePositiveInteger(value) !== null
        ? null
        : `${field} must be a positive integer`;

    case "harvesting_date":
      return isDate(value)
        ? null
        : "harvesting_date must be a valid YYYY-MM-DD date";

    case "harvesting_time":
      return isTime(value)
        ? null
        : "harvesting_time must be a valid HH:MM or HH:MM:SS time";

    case "harvest_lot_number":
      return isValidLotNumber(value)
        ? null
        : "harvest_lot_number must contain between 1 and 50 characters";

    default:
      return null;
  }
}

function normalizeValue(
  field: EditableField,
  value: unknown,
) {
  switch (field) {
    case "team_leader_user_id":
    case "field_id":
    case "vegetable_id":
    case "product_id":
    case "amount_of_boxes":
    case "box_type_id":
    case "harvester_id":
      return parsePositiveInteger(value);

    case "harvest_lot_number":
      return String(value).trim();

    default:
      return value;
  }
}

// =====================================================
// TRANSACTION HELPER
// =====================================================

async function transaction<T>(
  callback: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();

  let discardConnection = false;

  try {
    await db.query("BEGIN");

    await db.query(`
      SET TRANSACTION ISOLATION LEVEL READ COMMITTED
    `);

    // Shared inventory and traceability lock.
    // Always acquire before locking or modifying rows.
    await db.query(`
      SELECT pg_advisory_xact_lock(7142, 1)
    `);

    const result = await callback(db);

    await db.query("COMMIT");

    return result;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackError) {
      discardConnection = true;

      console.error(
        "Harvesting transaction rollback failed:",
        rollbackError,
      );
    }

    throw error;
  } finally {
    db.release(discardConnection);
  }
}

// =====================================================
// PRODUCT REFERENCE VALIDATION
// =====================================================

async function validateProductReference(
  db: PoolClient,
  productId: number,
  vegetableId: number,
) {
  const { rows } = await db.query(
    `
      SELECT
        pr.id,
        pr.raw_product_id,
        pr.finished_product_id,

        COALESCE(
          rp.vegetable_id,
          fp.vegetable_id
        ) AS vegetable_id

      FROM trackability.product_reference pr

      LEFT JOIN public.raw_product rp
        ON rp.id = pr.raw_product_id

      LEFT JOIN public.finished_product fp
        ON fp.id = pr.finished_product_id

      WHERE pr.id = $1
    `,
    [productId],
  );

  if (rows.length === 0) {
    throw new HttpError(
      400,
      "Product reference does not exist",
    );
  }

  const product = rows[0];

  if (Number(product.vegetable_id) !== vegetableId) {
    throw new HttpError(
      400,
      "Selected product does not match the selected vegetable",
    );
  }

  return product;
}

// =====================================================
// RESOLVE OR CREATE HARVEST LOT
// =====================================================

async function resolveHarvestLot(
  db: PoolClient,
  data: {
    lotNumber: string;
    productId: number;
    harvestingDate: string;
    fieldId: number;
    vegetableId: number;
  },
): Promise<string> {
  const {
    lotNumber,
    productId,
    harvestingDate,
    fieldId,
    vegetableId,
  } = data;

  await validateProductReference(
    db,
    productId,
    vegetableId,
  );

  // If the lot already exists, preserve its original identity.
  await db.query(
    `
      INSERT INTO trackability.lots (
        lot_number,
        lot_type,
        product_id,
        lot_date
      )
      VALUES (
        $1,
        'harvest',
        $2,
        $3::date
      )

      ON CONFLICT (lot_number)
      DO NOTHING
    `,
    [
      lotNumber,
      productId,
      harvestingDate,
    ],
  );

  // Retrieve and lock the existing or newly created lot.
  const { rows } = await db.query(
    `
      SELECT
        id::text AS id,
        lot_number,
        lot_type,
        product_id,
        lot_date::text AS lot_date

      FROM trackability.lots

      WHERE lot_number = $1

      FOR UPDATE
    `,
    [lotNumber],
  );

  const lot = rows[0];

  if (!lot) {
    throw new HttpError(
      500,
      "Could not resolve harvest lot",
    );
  }

  if (lot.lot_type !== "harvest") {
    throw new HttpError(
      409,
      "This lot number is already used by a production lot",
    );
  }

  if (Number(lot.product_id) !== productId) {
    throw new HttpError(
      409,
      "This harvest lot number already belongs to another product",
    );
  }

  if (lot.lot_date !== harvestingDate) {
    throw new HttpError(
      409,
      "This harvest lot number already belongs to another harvesting date",
    );
  }

  // All harvesting entries sharing this lot must belong
  // to the same field and vegetable.
  const existingHarvest = await db.query(
    `
      SELECT id

      FROM trackability.harvesting_tracking

      WHERE lot_id = $1
        AND (
          field_id IS DISTINCT FROM $2::integer

          OR vegetable_id IS DISTINCT FROM $3::integer
        )

      LIMIT 1
    `,
    [
      lot.id,
      fieldId,
      vegetableId,
    ],
  );

  if (existingHarvest.rows.length > 0) {
    throw new HttpError(
      409,
      "This harvest lot number already belongs to another field or vegetable",
    );
  }

  return lot.id;
}

// =====================================================
// READ HARVESTING RECORD
// =====================================================

async function readHarvesting(
  db: PoolClient,
  id: string,
) {
  const { rows } = await db.query(
    `
      ${baseQuery}
      WHERE h.id = $1
    `,
    [id],
  );

  if (rows.length === 0) {
    throw new HttpError(
      404,
      "Harvesting tracking record not found",
    );
  }

  return rows[0];
}

// =====================================================
// LOCK HARVESTING RECORD BEFORE EDITING
// =====================================================

async function lockHarvesting(
  db: PoolClient,
  id: string,
) {
  const { rows } = await db.query(
    `
      SELECT
        h.*,
        h.harvesting_date::text AS harvesting_date,
        l.lot_number AS harvest_lot_number,
        l.product_id

      FROM trackability.harvesting_tracking h

      JOIN trackability.lots l
        ON l.id = h.lot_id

      WHERE h.id = $1

      FOR UPDATE OF h
    `,
    [id],
  );

  if (rows.length === 0) {
    throw new HttpError(
      404,
      "Harvesting tracking record not found",
    );
  }

  return rows[0];
}

// =====================================================
// RECEPTION PROTECTION
// =====================================================

async function ensureNotReceived(
  db: PoolClient,
  id: string,
) {
  const { rows } = await db.query(
    `
      SELECT id

      FROM trackability.harvest_receipt_entries

      WHERE harvesting_id = $1

      LIMIT 1
    `,
    [id],
  );

  if (rows.length > 0) {
    throw new HttpError(
      409,
      "This harvesting entry is linked to a reception and can no longer be modified or deleted",
    );
  }
}

// =====================================================
// GET /
// =====================================================

router.get("/", readRoles, async (_req, res) => {
  try {
    const result = await pool.query(`
      ${baseQuery}

      ORDER BY
        h.harvesting_date DESC,
        h.harvesting_time DESC,
        h.id DESC
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    return databaseError(res, error);
  }
});

// =====================================================
// GET /:id
// =====================================================

router.get("/:id", readRoles, async (req, res) => {
  const id = parseBigIntId(req.params.id);

  if (id === null) {
    return res.status(400).json({
      error: "Invalid id",
    });
  }

  try {
    const { rows } = await pool.query(
      `
        ${baseQuery}
        WHERE h.id = $1
      `,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Harvesting tracking record not found",
      });
    }

    return res.status(200).json(rows[0]);
  } catch (error) {
    return databaseError(res, error);
  }
});

// =====================================================
// POST /
// =====================================================

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
      return res.status(400).json({ error });
    }
  }

  try {
    const result = await transaction(async (db) => {
      // Find or create the harvest lot.
      const lotId = await resolveHarvestLot(db, {
        lotNumber: String(
          req.body.harvest_lot_number,
        ).trim(),

        productId: parsePositiveInteger(
          req.body.product_id,
        )!,

        harvestingDate: req.body.harvesting_date,

        fieldId: parsePositiveInteger(
          req.body.field_id,
        )!,

        vegetableId: parsePositiveInteger(
          req.body.vegetable_id,
        )!,
      });

      // Insert the physical harvesting entry.
      // No inventory movement is created here.
      const { rows } = await db.query(
        `
          INSERT INTO trackability.harvesting_tracking (
            team_leader_user_id,
            field_id,
            harvesting_date,
            harvesting_time,
            vegetable_id,
            lot_id,
            amount_of_boxes,
            box_type_id,
            harvester_id,
            status,
            finalized_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            'finalized',
            NOW()
          )

          RETURNING id::text AS id
        `,
        [
          normalizeValue(
            "team_leader_user_id",
            req.body.team_leader_user_id,
          ),

          normalizeValue(
            "field_id",
            req.body.field_id,
          ),

          req.body.harvesting_date,
          req.body.harvesting_time,

          normalizeValue(
            "vegetable_id",
            req.body.vegetable_id,
          ),

          lotId,

          normalizeValue(
            "amount_of_boxes",
            req.body.amount_of_boxes,
          ),

          normalizeValue(
            "box_type_id",
            req.body.box_type_id,
          ),

          normalizeValue(
            "harvester_id",
            req.body.harvester_id,
          ),
        ],
      );

      return readHarvesting(db, rows[0].id);
    });

    return res.status(201).json(result);
  } catch (error) {
    return databaseError(res, error);
  }
});

// =====================================================
// PATCH /:id
// =====================================================

router.patch("/:id", writeRoles, async (req, res) => {
  const id = parseBigIntId(req.params.id);

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
      return res.status(400).json({ error });
    }
  }

  try {
    const result = await transaction(async (db) => {
      const existing = await lockHarvesting(db, id);

      // Prevent historical modifications.
      await ensureNotReceived(db, id);

      // Merge current data with the requested modifications.
      const updated: Record<string, any> = {
        ...existing,
      };

      for (const field of providedFields) {
        updated[field] = normalizeValue(
          field,
          req.body[field],
        );
      }

      // Determine whether a lot-defining field changed.
      const lotChanged =
        updated.harvest_lot_number !==
          existing.harvest_lot_number ||

        Number(updated.product_id) !==
          Number(existing.product_id) ||

        updated.harvesting_date !==
          existing.harvesting_date ||

        Number(updated.field_id) !==
          Number(existing.field_id) ||

        Number(updated.vegetable_id) !==
          Number(existing.vegetable_id);

      let lotId = String(existing.lot_id);

      if (lotChanged) {
        // Do not modify an existing shared lot's identity.
        // Resolve the correct lot instead.
        lotId = await resolveHarvestLot(db, {
          lotNumber: updated.harvest_lot_number,

          productId: Number(updated.product_id),

          harvestingDate: updated.harvesting_date,

          fieldId: Number(updated.field_id),

          vegetableId: Number(updated.vegetable_id),
        });
      }

      const fieldsToUpdate = directFields.filter(
        (field) => providedFields.includes(field),
      );

      const values: unknown[] = fieldsToUpdate.map(
        (field) => updated[field],
      );

      const assignments = fieldsToUpdate.map(
        (field, index) =>
          `${field} = $${index + 1}`,
      );

      if (lotChanged) {
        values.push(lotId);

        assignments.push(
          `lot_id = $${values.length}`,
        );
      }

      // For example, the frontend sent the existing
      // product_id again without actually changing it.
      if (assignments.length === 0) {
        return readHarvesting(db, id);
      }

      values.push(id);

      await db.query(
        `
          UPDATE trackability.harvesting_tracking

          SET ${assignments.join(", ")}

          WHERE id = $${values.length}
        `,
        values,
      );

      return readHarvesting(db, id);
    });

    return res.status(200).json(result);
  } catch (error) {
    return databaseError(res, error);
  }
});

// =====================================================
// DELETE /:id
// =====================================================

router.delete("/:id", writeRoles, async (req, res) => {
  const id = parseBigIntId(req.params.id);

  if (id === null) {
    return res.status(400).json({
      error: "Invalid id",
    });
  }

  try {
    const result = await transaction(async (db) => {
      await lockHarvesting(db, id);

      await ensureNotReceived(db, id);

      // Retrieve the complete record before deletion,
      // including its lot and product reference data.
      const existing = await readHarvesting(db, id);

      await db.query(
        `
          DELETE FROM trackability.harvesting_tracking
          WHERE id = $1
        `,
        [id],
      );

      // Intentionally preserve the lot record.
      // Other harvesting entries may share it.

      return existing;
    });

    return res.status(200).json(result);
  } catch (error) {
    return databaseError(res, error);
  }
});

export default router;