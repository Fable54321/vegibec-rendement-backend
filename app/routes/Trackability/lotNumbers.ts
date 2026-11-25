import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const readRoles = requireAppRole("main", [
  "admin",
  "user",
  "guest",
]);

type ProductSource =
  | "raw_product"
  | "finished_product";

// =====================================================
// QUERY PARAMETER VALIDATION
// =====================================================

const getQueryText = (
  value: unknown,
): string | null => {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;

  const text = value.trim();

  return text.length <= 100 ? text : null;
};

const getProductSource = (
  value: unknown,
): ProductSource | null | undefined => {
  if (value === undefined || value === "") {
    return null;
  }

  return value === "raw_product" ||
    value === "finished_product"
    ? value
    : undefined;
};

const getAvailability = (
  value: unknown,
): boolean | null | undefined => {
  if (value === undefined || value === "") {
    return null;
  }

  if (value === "true") return true;
  if (value === "false") return false;

  return undefined;
};

const getYear = (
  value: unknown,
): number | null | undefined => {
  if (value === undefined || value === "") {
    return Number(
      new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        timeZone: "America/Toronto",
      }).format(new Date()),
    );
  }

  // Explicitly request lots from all years.
  if (value === "all") {
    return null;
  }

  if (
    typeof value !== "string" ||
    !/^\d{4}$/.test(value)
  ) {
    return undefined;
  }

  const year = Number(value);

  return year >= 2000 && year <= 2100
    ? year
    : undefined;
};

const getId = (
  value: unknown,
): string | null | undefined => {
  if (value === undefined || value === "") {
    return null;
  }

  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    value.length > 19
  ) {
    return undefined;
  }

  try {
    return BigInt(value) <=
      BigInt("9223372036854775807")
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

const getProductReferenceId = (
  value: unknown,
): number | null | undefined => {
  const id = getId(value);

  if (id === null || id === undefined) {
    return id;
  }

  const parsed = Number(id);

  return Number.isSafeInteger(parsed) &&
    parsed <= 2147483647
    ? parsed
    : undefined;
};

const getLotType = (
  value: unknown,
): "harvest" | "production" | null | undefined => {
  if (value === undefined || value === "") {
    return null;
  }

  return value === "harvest" ||
    value === "production"
    ? value
    : undefined;
};

// =====================================================
// CENTRAL LOT JOURNAL
// =====================================================

/**
 * Inventory quantities come exclusively from
 * trackability.lot_balances.
 *
 * Harvesting and production records are aggregated
 * only to provide contextual information.
 *
 * One row per trackability.lots record.
 */

const lotJournalBaseSql = `
  WITH harvest_metadata AS (

    SELECT
      h.lot_id,

      COUNT(*)::integer AS source_count,

      SUM(h.amount_of_boxes)::bigint
        AS initial_quantity,

      ARRAY_AGG(
        DISTINCT h.status::text
        ORDER BY h.status::text
      ) AS source_statuses,

      MAX(
        (h.harvesting_date + h.harvesting_time)
        AT TIME ZONE 'America/Toronto'
      ) AS recorded_at

    FROM trackability.harvesting_tracking h

    GROUP BY h.lot_id

  ),

  production_metadata AS (

    SELECT
      po.lot_id,

      COUNT(*)::integer AS source_count,

      COALESCE(
        SUM(po.produced_boxes) FILTER (
          WHERE p.status <> 'cancelled'
        ),
        0
      )::bigint AS initial_quantity,

      ARRAY_AGG(
        DISTINCT p.status::text
        ORDER BY p.status::text
      ) AS source_statuses,

      BOOL_OR(
        p.status = 'in_progress'
      ) AS has_open_production,

      BOOL_AND(
        p.status = 'cancelled'
      ) AS all_cancelled,

      MAX(po.created_at) AS recorded_at

    FROM trackability.production_outputs po

    JOIN trackability.productions p
      ON p.id = po.production_id

    GROUP BY po.lot_id

  ),

  receipt_metadata AS (

    SELECT
      hr.lot_id,

      COUNT(*)::integer AS receipt_count,

      MAX(hr.received_at) AS last_received_at

    FROM trackability.harvest_receipts hr

    WHERE EXISTS (

      SELECT 1

      FROM trackability.lot_movements lm

      WHERE lm.receipt_id = hr.id
        AND lm.movement_type = 'harvest_receipt'

    )

    GROUP BY hr.lot_id

  ),

  movement_metadata AS (

    SELECT
      lm.lot_id,

      COUNT(*)::bigint AS movement_count,

      MAX(lm.created_at) AS last_movement_at,

      COALESCE(
        SUM(lm.total_delta) FILTER (
          WHERE lm.movement_type = 'harvest_receipt'
        ),
        0
      )::bigint AS received_boxes,

      COALESCE(
        SUM(lm.total_delta) FILTER (
          WHERE lm.movement_type = 'production_output'
        ),
        0
      )::bigint AS produced_boxes,

      COALESCE(
        SUM(lm.used_delta) FILTER (
          WHERE lm.movement_type = 'production_consumption'
        ),
        0
      )::bigint AS production_consumed_boxes,

      COALESCE(
        SUM(lm.reserved_delta) FILTER (
          WHERE lm.production_input_id IS NOT NULL
        ),
        0
      )::bigint AS production_reserved_boxes,

      COALESCE(
        SUM(lm.reserved_delta) FILTER (
          WHERE lm.sale_allocation_id IS NOT NULL
        ),
        0
      )::bigint AS sales_reserved_boxes,

      COALESCE(
        SUM(lm.used_delta) FILTER (
          WHERE lm.movement_type = 'shipment'
        ),
        0
      )::bigint AS shipped_boxes,

      COALESCE(
        -SUM(lm.used_delta) FILTER (
          WHERE lm.movement_type = 'return'
        ),
        0
      )::bigint AS returned_boxes,

      COALESCE(
        SUM(lm.used_delta) FILTER (
          WHERE lm.movement_type = 'loss'
        ),
        0
      )::bigint AS lost_boxes,

      COALESCE(
        SUM(lm.total_delta) FILTER (
          WHERE lm.movement_type = 'adjustment'
        ),
        0
      )::bigint AS adjusted_boxes

    FROM trackability.lot_movements lm

    GROUP BY lm.lot_id

  ),

  journal AS (

    SELECT

      -- ===============================================
      -- LOT IDENTITY
      -- ===============================================

      lb.lot_id,
      lb.lot_number,
      lb.lot_type,
      lb.lot_date,
      lb.created_at,

      CASE
        WHEN lb.lot_type = 'harvest'
          THEN 'harvesting_tracking'

        ELSE 'production_outputs'

      END AS lot_source,


      -- ===============================================
      -- PRODUCT INFORMATION
      -- ===============================================

      lb.product_id AS product_reference_id,

      lb.raw_product_id,
      lb.finished_product_id,

      CASE
        WHEN lb.raw_product_id IS NOT NULL
          THEN 'raw_product'

        ELSE 'finished_product'

      END AS product_source,

      -- Preserve previous API semantics:
      -- product_id is the original product table ID.
      COALESCE(
        lb.raw_product_id,
        lb.finished_product_id
      ) AS product_id,

      COALESCE(
        lb.raw_product_id,
        lb.finished_product_id
      ) AS source_product_id,

      COALESCE(
        rp.product_code::text,
        fp.product_code::text
      ) AS product_code,

      COALESCE(
        rp.description,
        fp.full_name
      ) AS product_name,

      COALESCE(
        rp.vegetable_id,
        fp.vegetable_id
      ) AS vegetable_id,

      COALESCE(
        rp.qty_per_pallet,
        fp.qty_per_pallet
      ) AS qty_per_pallet,

      COALESCE(
        rp.is_active,
        fp.is_active
      ) AS product_is_active,


      -- ===============================================
      -- SOURCE INFORMATION
      -- ===============================================

      CASE
        WHEN lb.lot_type = 'harvest'
          THEN COALESCE(h.source_count, 0)

        ELSE COALESCE(p.source_count, 0)

      END AS source_count,

      CASE
        WHEN lb.lot_type = 'harvest'
          THEN COALESCE(h.initial_quantity, 0)

        ELSE COALESCE(p.initial_quantity, 0)

      END AS initial_quantity,

      CASE
        WHEN lb.lot_type = 'harvest'
          THEN COALESCE(
            h.source_statuses,
            ARRAY[]::text[]
          )

        ELSE COALESCE(
          p.source_statuses,
          ARRAY[]::text[]
        )

      END AS source_statuses,

      COALESCE(r.receipt_count, 0)
        AS receipt_count,

      r.last_received_at,

      COALESCE(m.movement_count, 0)
        AS movement_count,

      m.last_movement_at,


      -- ===============================================
      -- AUTHORITATIVE INVENTORY BALANCE
      -- ===============================================

      lb.total_boxes,
      lb.reserved_boxes,
      lb.used_boxes,
      lb.available_boxes,

      -- Physical stock remaining before reservations.
      (lb.total_boxes - lb.used_boxes)
        AS remaining_boxes,


      -- ===============================================
      -- MOVEMENT BREAKDOWN
      -- ===============================================

      COALESCE(m.received_boxes, 0)
        AS received_boxes,

      COALESCE(m.produced_boxes, 0)
        AS produced_boxes,

      COALESCE(m.production_consumed_boxes, 0)
        AS production_consumed_boxes,

      COALESCE(m.production_reserved_boxes, 0)
        AS production_reserved_boxes,

      COALESCE(m.sales_reserved_boxes, 0)
        AS sales_reserved_boxes,

      COALESCE(m.shipped_boxes, 0)
        AS shipped_boxes,

      COALESCE(m.returned_boxes, 0)
        AS returned_boxes,

      COALESCE(m.lost_boxes, 0)
        AS lost_boxes,

      COALESCE(m.adjusted_boxes, 0)
        AS adjusted_boxes,


      -- ===============================================
      -- LEGACY RESPONSE FIELDS
      -- ===============================================

      lb.total_boxes AS incoming_quantity,

      lb.used_boxes AS consumed_quantity,

      lb.reserved_boxes AS reserved_quantity,

      (lb.total_boxes - lb.used_boxes)
        AS available_quantity,

      lb.available_boxes
        AS projected_available_quantity,

      (lb.total_boxes - lb.used_boxes > 0)
        AS is_available,

      (lb.available_boxes > 0)
        AS is_projected_available,

      (lb.available_boxes > 0)
        AS can_reserve,


      -- ===============================================
      -- HARVEST RECEPTION INFORMATION
      -- ===============================================

      CASE
        WHEN lb.lot_type = 'harvest' THEN

          GREATEST(
            COALESCE(h.initial_quantity, 0)
            - COALESCE(m.received_boxes, 0),
            0
          )

        ELSE 0

      END AS pending_receipt_boxes,

      CASE
        WHEN lb.lot_type = 'harvest' THEN

          GREATEST(
            COALESCE(m.received_boxes, 0)
            - COALESCE(h.initial_quantity, 0),
            0
          )

        ELSE 0

      END AS excess_received_boxes,


      -- ===============================================
      -- AVAILABILITY STATUS
      -- ===============================================

      CASE

        WHEN lb.total_boxes < 0
          OR lb.reserved_boxes < 0
          OR lb.used_boxes < 0
            THEN 'inconsistent'

        WHEN lb.available_boxes < 0
            THEN 'negative_availability'

        WHEN COALESCE(h.source_count, 0) = 0
          AND COALESCE(p.source_count, 0) = 0
          AND COALESCE(m.movement_count, 0) = 0
            THEN 'unused'

        WHEN lb.lot_type = 'production'
          AND COALESCE(p.all_cancelled, FALSE)
          AND COALESCE(m.produced_boxes, 0) = 0
            THEN 'cancelled'

        WHEN lb.lot_type = 'harvest'
          AND COALESCE(m.received_boxes, 0) = 0
          AND lb.total_boxes = 0
            THEN 'pending_receipt'

        WHEN lb.lot_type = 'production'
          AND COALESCE(p.has_open_production, FALSE)
          AND COALESCE(m.produced_boxes, 0) = 0
          AND lb.total_boxes = 0
            THEN 'in_progress'

        WHEN lb.total_boxes - lb.used_boxes <= 0
            THEN 'unavailable'

        WHEN lb.available_boxes <= 0
            THEN 'reserved'

        WHEN lb.reserved_boxes > 0
            THEN 'partially_reserved'

        ELSE 'available'

      END AS availability_status,

      (
        lb.total_boxes < 0
        OR lb.reserved_boxes < 0
        OR lb.used_boxes < 0
        OR lb.available_boxes < 0
      ) AS has_balance_issue,

      GREATEST(
        lb.created_at,
        h.recorded_at,
        p.recorded_at,
        r.last_received_at
      ) AS recorded_at

    FROM trackability.lot_balances lb

    LEFT JOIN public.raw_product rp
      ON rp.id = lb.raw_product_id

    LEFT JOIN public.finished_product fp
      ON fp.id = lb.finished_product_id

    LEFT JOIN harvest_metadata h
      ON h.lot_id = lb.lot_id

    LEFT JOIN production_metadata p
      ON p.lot_id = lb.lot_id

    LEFT JOIN receipt_metadata r
      ON r.lot_id = lb.lot_id

    LEFT JOIN movement_metadata m
      ON m.lot_id = lb.lot_id

  )

  SELECT *
  FROM journal
`;

// =====================================================
// EXPORTED QUERY
// =====================================================

/**
 * Existing six-parameter interface preserved:
 *
 * $1: Search text
 * $2: Product source
 * $3: Physical availability
 * $4: Lot year
 * $5: Original product ID
 * $6: Unreserved availability
 */

const lotJournalFiltersSql = `
  WHERE (

    $1::text = ''

    OR lot_number ILIKE '%' || $1 || '%'

    OR product_code ILIKE '%' || $1 || '%'

    OR product_name ILIKE '%' || $1 || '%'

  )

  AND (
    $2::text IS NULL
    OR product_source = $2
  )

  AND (
    $3::boolean IS NULL
    OR is_available = $3
  )

  AND (
    $4::integer IS NULL

    OR (
      lot_date >= make_date($4::integer, 1, 1)
      AND lot_date < make_date($4::integer + 1, 1, 1)
    )
  )

  AND (
    $5::bigint IS NULL
    OR product_id = $5
  )

  AND (
    $6::boolean IS NULL
    OR is_projected_available = $6
  )
`;

const lotJournalOrderSql = `
  ORDER BY
    recorded_at DESC NULLS LAST,
    lot_number DESC,
    lot_id DESC
`;

export const lotJournalSql = `
  ${lotJournalBaseSql}
  ${lotJournalFiltersSql}
  ${lotJournalOrderSql}
`;

// =====================================================
// GET /
// =====================================================

/**
 * GET /trackability/lot-numbers
 *
 * Optional filters:
 *
 * q=lot/product text
 * productSource=raw_product|finished_product
 * productId=original product ID
 * productReferenceId=centralized product reference ID
 * lotType=harvest|production
 * available=true|false
 * projectedAvailable=true|false
 * year=YYYY|all
 */

router.get("/", readRoles, async (req, res) => {
  const query = getQueryText(req.query.q);

  const productSource = getProductSource(
    req.query.productSource,
  );

  const available = getAvailability(
    req.query.available,
  );

  const projectedAvailable = getAvailability(
    req.query.projectedAvailable,
  );

  const year = getYear(req.query.year);

  const productId = getId(
    req.query.productId,
  );

  const productReferenceId = getProductReferenceId(
    req.query.productReferenceId,
  );

  const lotType = getLotType(
    req.query.lotType,
  );

  if (query === null) {
    return res.status(400).json({
      error: "q must be a string of at most 100 characters",
    });
  }

  if (productSource === undefined) {
    return res.status(400).json({
      error:
        "productSource must be raw_product or finished_product",
    });
  }

  if (available === undefined) {
    return res.status(400).json({
      error: "available must be true or false",
    });
  }

  if (projectedAvailable === undefined) {
    return res.status(400).json({
      error: "projectedAvailable must be true or false",
    });
  }

  if (year === undefined) {
    return res.status(400).json({
      error:
        "year must be between 2000 and 2100, or 'all'",
    });
  }

  if (productId === undefined) {
    return res.status(400).json({
      error: "Invalid productId",
    });
  }

  if (
    productId !== null &&
    productSource === null
  ) {
    return res.status(400).json({
      error:
        "productSource is required when filtering by productId",
    });
  }

  if (productReferenceId === undefined) {
    return res.status(400).json({
      error: "Invalid productReferenceId",
    });
  }

  if (lotType === undefined) {
    return res.status(400).json({
      error: "lotType must be harvest or production",
    });
  }

  try {
    const { rows } = await pool.query(
      `
        ${lotJournalBaseSql}
        ${lotJournalFiltersSql}

        AND (
          $7::integer IS NULL
          OR product_reference_id = $7
        )

        AND (
          $8::text IS NULL
          OR lot_type = $8
        )

        ${lotJournalOrderSql}
      `,
      [
        query,
        productSource,
        available,
        year,
        productId,
        projectedAvailable,
        productReferenceId,
        lotType,
      ],
    );

    return res.status(200).json(rows);
  } catch (error) {
    console.error(
      "Lot journal database error:",
      error,
    );

    return res.status(500).json({
      error: "Failed to fetch lot journal",
    });
  }
});

// =====================================================
// GET /by-number/:lotNumber
// =====================================================

/**
 * Exact lot number lookup.
 *
 * Useful for barcode scanners, pallet preparation
 * and production input selection.
 *
 * No year restriction.
 */

router.get(
  "/by-number/:lotNumber",
  readRoles,
  async (req, res) => {
    const lotNumber =
      typeof req.params.lotNumber === "string"
        ? req.params.lotNumber.trim()
        : "";

    if (
      lotNumber.length === 0 ||
      lotNumber.length > 50
    ) {
      return res.status(400).json({
        error: "Invalid lot number",
      });
    }

    try {
      const { rows } = await pool.query(
        `
          ${lotJournalBaseSql}
          WHERE lot_number = $1
        `,
        [lotNumber],
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Lot not found",
        });
      }

      return res.status(200).json(rows[0]);
    } catch (error) {
      console.error(
        "Lot lookup error:",
        error,
      );

      return res.status(500).json({
        error: "Failed to fetch lot",
      });
    }
  },
);

// =====================================================
// GET /:id/movements
// =====================================================

/**
 * Complete inventory movement history for a lot.
 */

router.get(
  "/:id/movements",
  readRoles,
  async (req, res) => {
    const id = getId(req.params.id);

    if (!id) {
      return res.status(400).json({
        error: "Invalid lot id",
      });
    }

    try {
      const { rows } = await pool.query(
        `
          SELECT

            l.id AS lot_id,

            l.lot_number,

            COALESCE(

              (

                SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', lm.id::text,
                    'lot_id', lm.lot_id::text,
                    'movement_type', lm.movement_type,

                    'total_delta', lm.total_delta,
                    'reserved_delta', lm.reserved_delta,
                    'used_delta', lm.used_delta,

                    'receipt_id', lm.receipt_id,
                    'production_input_id', lm.production_input_id,
                    'production_output_id', lm.production_output_id,

                    'sale_allocation_id',
                      lm.sale_allocation_id::text,

                    'pallet_allocation_id',
                      lm.pallet_allocation_id::text,

                    'created_by_user_id', lm.created_by_user_id,
                    'notes', lm.notes,
                    'created_at', lm.created_at
                  )
                  ORDER BY
                    lm.created_at DESC,
                    lm.id DESC
                )

                FROM trackability.lot_movements lm

                WHERE lm.lot_id = l.id

              ),

              '[]'::jsonb

            ) AS movements

          FROM trackability.lots l

          WHERE l.id = $1
        `,
        [id],
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Lot not found",
        });
      }

      return res.status(200).json(
        rows[0].movements,
      );
    } catch (error) {
      console.error(
        "Lot movements database error:",
        error,
      );

      return res.status(500).json({
        error: "Failed to fetch lot movements",
      });
    }
  },
);

// =====================================================
// GET /:id
// =====================================================

/**
 * Retrieve one lot using its internal database ID.
 */

router.get("/:id", readRoles, async (req, res) => {
  const id = getId(req.params.id);

  if (!id) {
    return res.status(400).json({
      error: "Invalid lot id",
    });
  }

  try {
    const { rows } = await pool.query(
      `
        ${lotJournalBaseSql}
        WHERE lot_id = $1
      `,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Lot not found",
      });
    }

    return res.status(200).json(rows[0]);
  } catch (error) {
    console.error(
      "Lot details database error:",
      error,
    );

    return res.status(500).json({
      error: "Failed to fetch lot details",
    });
  }
});

export default router;