
import { Router, type RequestHandler } from "express";
import { pool } from "../../../db";
import { requireAppRole } from "../../../middleware/auth";

const router = Router();

const readAccess = requireAppRole("main", [
  "admin",
  "user",
  "guest",
]);

const writeAccess = requireAppRole("main", [
  "admin",
  "user",
]);

const deleteAccess = requireAppRole("main", ["admin"]);

// ==========================================
// TYPES
// ==========================================

type PlanStatus = "draft" | "confirmed" | "cancelled";

interface GreenhousePlanInput {
  season: number;
  vegetable_id: number;
  cultivar_id: number;

  planned_sowing_date: string;
  greenhouse_days: number;
  tray_cell_count: number;

  plants_per_acre: number | null;
  seedling_buffer_percentage: number;
  planned_area_ac: number;

  planned_seedlings: number | null;
  planned_tray_count: number | null;

  planned_transplant_date: string | null;
  expected_harvest_start: string | null;
  expected_harvest_end: string | null;

  greenhouse_number: string | null;
  status: PlanStatus;
  notes: string | null;
}

const editableFields: (keyof GreenhousePlanInput)[] = [
  "season",
  "vegetable_id",
  "cultivar_id",
  "planned_sowing_date",
  "greenhouse_days",
  "tray_cell_count",
  "plants_per_acre",
  "seedling_buffer_percentage",
  "planned_area_ac",
  "planned_seedlings",
  "planned_tray_count",
  "planned_transplant_date",
  "expected_harvest_start",
  "expected_harvest_end",
  "greenhouse_number",
  "status",
  "notes",
];

const statuses: PlanStatus[] = [
  "draft",
  "confirmed",
  "cancelled",
];

const isObject = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value);

const positiveInteger = (value: unknown) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0;

const nonNegativeInteger = (value: unknown) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0;

const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);

// Accept only real calendar dates in YYYY-MM-DD.
function validDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function optionalDate(value: unknown) {
  return value === null || validDate(value);
}

function optionalString(value: unknown) {
  return (
    value === null ||
    (typeof value === "string" && value.length <= 10000)
  );
}

function normalizePlan(row: Record<string, any>) {
  const numericFields = [
    "id",
    "season",
    "vegetable_id",
    "cultivar_id",
    "greenhouse_days",
    "tray_cell_count",
    "plants_per_acre",
    "seedling_buffer_percentage",
    "planned_area_ac",
    "planned_seedlings",
    "planned_tray_count",
  ];

  const result = { ...row };

  for (const field of numericFields) {
    if (result[field] != null) {
      result[field] = Number(result[field]);
    }
  }

  return result;
}

// ==========================================
// VALIDATION
// ==========================================

function validatePlan(
  input: Record<string, unknown>,
): string | null {
  if (
    !nonNegativeInteger(input.season) ||
    Number(input.season) < 2020 ||
    Number(input.season) > 2100
  ) {
    return "Invalid production season";
  }

  if (
    !positiveInteger(input.vegetable_id) ||
    !positiveInteger(input.cultivar_id)
  ) {
    return "Valid vegetable_id and cultivar_id are required";
  }

  if (!validDate(input.planned_sowing_date)) {
    return "A valid planned_sowing_date is required";
  }

  if (!positiveInteger(input.greenhouse_days)) {
    return "greenhouse_days must be a positive integer";
  }

  if (!positiveInteger(input.tray_cell_count)) {
    return "tray_cell_count must be a positive integer";
  }

  if (
    input.plants_per_acre !== null &&
    !positiveInteger(input.plants_per_acre)
  ) {
    return "plants_per_acre must be positive or null";
  }

  if (
    !finiteNumber(input.seedling_buffer_percentage) ||
    Number(input.seedling_buffer_percentage) < 0 ||
    Number(input.seedling_buffer_percentage) > 100
  ) {
    return "seedling_buffer_percentage must be between 0 and 100";
  }

  if (
    !finiteNumber(input.planned_area_ac) ||
    Number(input.planned_area_ac) <= 0
  ) {
    return "planned_area_ac must be greater than zero";
  }

  for (const key of [
    "planned_seedlings",
    "planned_tray_count",
  ] as const) {
    if (
      input[key] !== null &&
      !nonNegativeInteger(input[key])
    ) {
      return `${key} must be a non-negative integer or null`;
    }
  }

  for (const key of [
    "planned_transplant_date",
    "expected_harvest_start",
    "expected_harvest_end",
  ] as const) {
    if (!optionalDate(input[key])) {
      return `Invalid ${key}`;
    }
  }

  const sowing = input.planned_sowing_date as string;
  const transplant = input.planned_transplant_date as
    | string
    | null;
  const harvestStart = input.expected_harvest_start as
    | string
    | null;
  const harvestEnd = input.expected_harvest_end as
    | string
    | null;

  if (transplant && transplant < sowing) {
    return "Transplant date cannot precede sowing date";
  }

  if (transplant && harvestStart && harvestStart < transplant) {
    return "Harvest cannot begin before transplantation";
  }

  if (harvestStart && harvestEnd && harvestEnd < harvestStart) {
    return "Harvest end cannot precede harvest start";
  }

  if (
    !statuses.includes(input.status as PlanStatus)
  ) {
    return "Invalid plan status";
  }

  if (!optionalString(input.notes)) {
    return "Invalid notes";
  }

  if (
    input.greenhouse_number !== null &&
    (
      typeof input.greenhouse_number !== "string" ||
      input.greenhouse_number.length > 50
    )
  ) {
    return "Invalid greenhouse_number";
  }

  return null;
}

// Ensure the cultivar belongs to the vegetable.
async function cultivarMatchesVegetable(
  cultivarId: number,
  vegetableId: number,
): Promise<boolean> {
  const result = await pool.query(
    `
    SELECT 1
    FROM public.cultivars
    WHERE id = $1
      AND vegetable_id = $2
    LIMIT 1
    `,
    [cultivarId, vegetableId],
  );

  return (result.rowCount ?? 0) > 0;
}

// ==========================================
// GET /summary
// Production summary for a season
// ==========================================

router.get(
  "/summary",
  readAccess,
  (async (req, res) => {
    try {
      const season = Number(req.query.season);

      if (!Number.isInteger(season) || season < 2020 || season > 2100) {
        res.status(400).json({
          error: "A valid season query parameter is required",
        });
        return;
      }

      const result = await pool.query(
        `
        SELECT
          COUNT(*)::int AS total_plans,

          COUNT(*) FILTER (
            WHERE status = 'draft'
          )::int AS draft_plans,

          COUNT(*) FILTER (
            WHERE status = 'confirmed'
          )::int AS confirmed_plans,

          COUNT(*) FILTER (
            WHERE status = 'cancelled'
          )::int AS cancelled_plans,

          COUNT(DISTINCT cultivar_id)::int
            AS distinct_cultivars,

          COALESCE(
            SUM(planned_area_ac) FILTER (
              WHERE status <> 'cancelled'
            ), 0
          )::float8 AS total_area_ac,

          COALESCE(
            SUM(planned_seedlings) FILTER (
              WHERE status <> 'cancelled'
            ), 0
          )::float8 AS total_seedlings,

          COALESCE(
            SUM(planned_tray_count) FILTER (
              WHERE status <> 'cancelled'
            ), 0
          )::float8 AS total_trays

        FROM trackability.greenhouse_production_plans
        WHERE season = $1
        `,
        [season],
      );

      res.json({
        season,
        ...result.rows[0],
      });
    } catch (error) {
      console.error("Error fetching greenhouse summary:", error);

      res.status(500).json({
        error: "Failed to fetch greenhouse summary",
      });
    }
  }) as RequestHandler,
);

// ==========================================
// GET /
// List greenhouse plans
// Optional filters:
// ?season=2027
// ?vegetable_id=25
// ?cultivar_id=42
// ?status=confirmed
// ==========================================

router.get(
  "/",
  readAccess,
  (async (req, res) => {
    try {
      const conditions: string[] = [];
      const values: (number | string)[] = [];

      const numericFilters = [
        "season",
        "vegetable_id",
        "cultivar_id",
      ] as const;

      for (const key of numericFilters) {
        const raw = req.query[key];

        if (raw === undefined) continue;

        const value = Number(raw);

        if (
          typeof raw !== "string" ||
          !Number.isSafeInteger(value) ||
          value <= 0 ||
          (key === "season" && (value < 2020 || value > 2100))
        ) {
          res.status(400).json({
            error: `Invalid ${key} filter`,
          });
          return;
        }

        values.push(value);
        conditions.push(`gp.${key} = $${values.length}`);
      }

      if (req.query.status !== undefined) {
        const status = req.query.status;

        if (
          typeof status !== "string" ||
          !statuses.includes(status as PlanStatus)
        ) {
          res.status(400).json({
            error: "Invalid status filter",
          });
          return;
        }

        values.push(status);
        conditions.push(`gp.status = $${values.length}`);
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

      const result = await pool.query(
        `
        SELECT gp.*
        FROM trackability.greenhouse_production_plans gp

        ${where}

        ORDER BY
          gp.planned_sowing_date ASC,
          gp.id ASC
        `,
        values,
      );

      res.json(result.rows.map(normalizePlan));
    } catch (error) {
      console.error("Error fetching greenhouse plans:", error);

      res.status(500).json({
        error: "Failed to fetch greenhouse plans",
      });
    }
  }) as RequestHandler,
);

// ==========================================
// GET /:id
// ==========================================

router.get(
  "/:id",
  readAccess,
  (async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!positiveInteger(id)) {
        res.status(400).json({
          error: "Invalid greenhouse plan ID",
        });
        return;
      }

      const result = await pool.query(
        `
        SELECT *
        FROM trackability.greenhouse_production_plans
        WHERE id = $1
        `,
        [id],
      );

      if (!result.rows.length) {
        res.status(404).json({
          error: "Greenhouse plan not found",
        });
        return;
      }

      res.json(normalizePlan(result.rows[0]));
    } catch (error) {
      console.error("Error fetching greenhouse plan:", error);

      res.status(500).json({
        error: "Failed to fetch greenhouse plan",
      });
    }
  }) as RequestHandler,
);

// ==========================================
// POST /
// Create greenhouse production plan
// ==========================================

router.post(
  "/",
  writeAccess,
  (async (req, res) => {
    try {
      if (!isObject(req.body)) {
        res.status(400).json({
          error: "A valid request body is required",
        });
        return;
      }

      const defaults: Record<string, unknown> = {
        plants_per_acre: null,
        seedling_buffer_percentage: 10,
        planned_seedlings: null,
        planned_tray_count: null,
        planned_transplant_date: null,
        expected_harvest_start: null,
        expected_harvest_end: null,
        greenhouse_number: null,
        status: "draft",
        notes: null,
      };

      const input = {
        ...defaults,
        ...req.body,
      };

      const validationError = validatePlan(input);

      if (validationError) {
        res.status(400).json({
          error: validationError,
        });
        return;
      }

      const validCultivar = await cultivarMatchesVegetable(
        input.cultivar_id as number,
        input.vegetable_id as number,
      );

      if (!validCultivar) {
        res.status(400).json({
          error:
            "The selected cultivar does not belong to this vegetable",
        });
        return;
      }

      const columns = editableFields.map((field) => `"${field}"`);

      const placeholders = editableFields.map(
        (_, index) => `$${index + 1}`,
      );

      const values = editableFields.map(
        (field) => input[field],
      );

      const result = await pool.query(
        `
        INSERT INTO trackability.greenhouse_production_plans (
          ${columns.join(", ")}
        )
        VALUES (${placeholders.join(", ")})
        RETURNING *
        `,
        values,
      );

      res.status(201).json(normalizePlan(result.rows[0]));
    } catch (error: any) {
      console.error("Error creating greenhouse plan:", error);

      if (["23503", "23514", "22003", "22007", "22008"].includes(error.code)) {
        res.status(400).json({
          error: "Invalid greenhouse plan data",
        });
        return;
      }

      res.status(500).json({
        error: "Failed to create greenhouse plan",
      });
    }
  }) as RequestHandler,
);

// ==========================================
// PATCH /:id
// Update selected fields
// ==========================================

router.patch(
  "/:id",
  writeAccess,
  (async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!positiveInteger(id)) {
        res.status(400).json({
          error: "Invalid greenhouse plan ID",
        });
        return;
      }

      if (!isObject(req.body)) {
        res.status(400).json({
          error: "Invalid request body",
        });
        return;
      }

      const fieldsToUpdate = editableFields.filter(
        (field) =>
          Object.prototype.hasOwnProperty.call(req.body, field),
      );

      if (fieldsToUpdate.length === 0) {
        res.status(400).json({
          error: "No valid fields provided for update",
        });
        return;
      }

      const existing = await pool.query(
        `
        SELECT *
        FROM trackability.greenhouse_production_plans
        WHERE id = $1
        `,
        [id],
      );

      if (!existing.rows.length) {
        res.status(404).json({
          error: "Greenhouse plan not found",
        });
        return;
      }

      // Normalize PostgreSQL dates and NUMERIC columns
      // before merging them with incoming values.
      const original = normalizePlan(existing.rows[0]);

      const dateFields = [
        "planned_sowing_date",
        "planned_transplant_date",
        "expected_harvest_start",
        "expected_harvest_end",
      ];

      for (const field of dateFields) {
        if (original[field] instanceof Date) {
          original[field] = original[field]
            .toISOString()
            .slice(0, 10);
        }
      }

      const merged = {
        ...original,
        ...req.body,
      };

      const validationError = validatePlan(merged);

      if (validationError) {
        res.status(400).json({
          error: validationError,
        });
        return;
      }

      const validCultivar = await cultivarMatchesVegetable(
        merged.cultivar_id,
        merged.vegetable_id,
      );

      if (!validCultivar) {
        res.status(400).json({
          error:
            "The selected cultivar does not belong to this vegetable",
        });
        return;
      }

      const updates = fieldsToUpdate.map(
        (field, index) =>
          `"${field}" = $${index + 1}`,
      );

      const values = fieldsToUpdate.map(
        (field) => req.body[field],
      );

      values.push(id);

      const result = await pool.query(
        `
        UPDATE trackability.greenhouse_production_plans
        SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING *
        `,
        values,
      );

      if (!result.rows.length) {
        res.status(404).json({
          error: "Greenhouse plan not found",
        });
        return;
      }

      res.json(normalizePlan(result.rows[0]));
    } catch (error: any) {
      console.error("Error updating greenhouse plan:", error);

      if (["23503", "23514", "22003", "22007", "22008"].includes(error.code)) {
        res.status(400).json({
          error: "Invalid greenhouse plan data",
        });
        return;
      }

      res.status(500).json({
        error: "Failed to update greenhouse plan",
      });
    }
  }) as RequestHandler,
);

// ==========================================
// DELETE /:id
// ==========================================

router.delete(
  "/:id",
  deleteAccess,
  (async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!positiveInteger(id)) {
        res.status(400).json({
          error: "Invalid greenhouse plan ID",
        });
        return;
      }

      const result = await pool.query(
        `
        DELETE FROM trackability.greenhouse_production_plans
        WHERE id = $1
        RETURNING id
        `,
        [id],
      );

      if (!result.rows.length) {
        res.status(404).json({
          error: "Greenhouse plan not found",
        });
        return;
      }

      res.status(200).json({
        message: "Greenhouse plan deleted",
        id: Number(result.rows[0].id),
      });
    } catch (error: any) {
      console.error("Error deleting greenhouse plan:", error);

      if (error.code === "23503") {
        res.status(409).json({
          error:
            "This greenhouse plan is referenced by another record and cannot be deleted",
        });
        return;
      }

      res.status(500).json({
        error: "Failed to delete greenhouse plan",
      });
    }
  }) as RequestHandler,
);

export default router;
