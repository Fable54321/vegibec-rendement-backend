import { Router } from "express";

import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";
import { ensureSalesLotAllocationsTable } from "../sales/salesLotAllocations";

const router = Router();
const readRoles = requireAppRole("main", ["admin", "user", "guest"]);

type ProductSource = "raw_product" | "finished_product";

const getQueryText = (value: unknown): string | null => {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;

  const text = value.trim();
  return text.length <= 100 ? text : null;
};

const getProductSource = (value: unknown): ProductSource | null | undefined => {
  if (value === undefined || value === "") return null;
  return value === "raw_product" || value === "finished_product"
    ? value
    : undefined;
};

const getAvailability = (value: unknown): boolean | null | undefined => {
  if (value === undefined || value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
};

const getYear = (value: unknown): number | undefined => {
  if (value === undefined || value === "") return new Date().getFullYear();
  if (typeof value !== "string" || !/^\d{4}$/.test(value)) return undefined;

  const year = Number(value);
  return year >= 2000 && year <= 2100 ? year : undefined;
};

/**
 * Every created lot is journaled. It only becomes inventory after a harvest
 * receipt has been created or its production has been completed. Completed
 * production inputs reduce current quantity; in-progress inputs are reserved.
 */
export const lotJournalSql = `
  WITH harvest_lots AS (
    SELECT
      h.harvest_lot_number::text AS lot_number,
      pr.raw_product_id,
      pr.finished_product_id,
      COUNT(*)::int AS source_count,
      COALESCE(SUM(h.amount_of_boxes), 0)::bigint AS initial_quantity,
      ARRAY_AGG(DISTINCT h.status ORDER BY h.status)::text[]
        AS source_statuses,
      MAX(
        (h.harvesting_date + h.harvesting_time)::timestamp
      ) AS recorded_at
    FROM trackability.harvesting_tracking h
    JOIN trackability.product_reference pr
      ON pr.id = h.product_id
    WHERE h.harvest_lot_number IS NOT NULL
      AND (pr.raw_product_id IS NULL) <> (pr.finished_product_id IS NULL)
    GROUP BY
      h.harvest_lot_number,
      pr.raw_product_id,
      pr.finished_product_id
  ),
  receipt_stock AS (
    SELECT
      r.id AS source_id,
      'harvest_receipt'::text AS lot_source,
      r.harvest_lot_number::text AS lot_number,
      MIN(pr.raw_product_id) AS raw_product_id,
      MIN(pr.finished_product_id) AS finished_product_id,
      COALESCE(SUM(re.received_boxes), 0)::bigint AS incoming_quantity,
      r.received_at AS recorded_at
    FROM trackability.harvest_receipts r
    JOIN trackability.harvest_receipt_entries re
      ON re.receipt_id = r.id
    JOIN trackability.harvesting_tracking h
      ON h.id = re.harvesting_id
    JOIN trackability.product_reference pr
      ON pr.id = h.product_id
    WHERE r.harvest_lot_number IS NOT NULL
    GROUP BY r.id, r.harvest_lot_number, r.received_at
    HAVING COUNT(DISTINCT h.product_id) = 1
      AND BOOL_AND(
        (pr.raw_product_id IS NULL) <> (pr.finished_product_id IS NULL)
      )
  ),
  source_usage AS (
    SELECT
      CASE
        WHEN pi.receipt_id IS NOT NULL THEN 'harvest_receipt'
        ELSE 'production_outputs'
      END AS lot_source,
      COALESCE(pi.receipt_id, pi.source_production_output_id) AS source_id,
      COALESCE(
        SUM(pi.used_boxes) FILTER (WHERE p.status = 'completed'),
        0
      )::bigint AS consumed_quantity,
      COALESCE(
        SUM(pi.used_boxes) FILTER (WHERE p.status = 'in_progress'),
        0
      )::bigint AS reserved_quantity
    FROM trackability.production_inputs pi
    JOIN trackability.productions p
      ON p.id = pi.production_id
    WHERE p.status <> 'cancelled'
    GROUP BY 1, 2
  ),
  sales_usage AS (
    SELECT
      a.lot_source,
      a.lot_number,
      a.finished_product_id,
      COALESCE(
        SUM(a.quantity) FILTER (
          WHERE o.status IN ('expedie', 'facture')
        ),
        0
      )::numeric AS consumed_quantity,
      COALESCE(
        SUM(a.quantity) FILTER (
          WHERE o.status IN ('a-faire', 'en-cours')
        ),
        0
      )::numeric AS reserved_quantity
    FROM sales.order_item_lot_allocations a
    JOIN sales.orders o
      ON o.id = a.order_id
    GROUP BY
      a.lot_source,
      a.lot_number,
      a.finished_product_id
  ),
  receipt_inventory AS (
    SELECT
      s.lot_number,
      s.raw_product_id,
      s.finished_product_id,
      SUM(s.incoming_quantity)::bigint AS incoming_quantity,
      SUM(COALESCE(u.consumed_quantity, 0))::bigint AS consumed_quantity,
      SUM(COALESCE(u.reserved_quantity, 0))::bigint AS reserved_quantity,
      MAX(s.recorded_at) AS recorded_at
    FROM receipt_stock s
    LEFT JOIN source_usage u
      ON u.lot_source = s.lot_source
      AND u.source_id = s.source_id
    GROUP BY
      s.lot_number,
      s.raw_product_id,
      s.finished_product_id
  ),
  harvest_journal AS (
    SELECT
      h.lot_number,
      'harvesting_tracking'::text AS lot_source,
      h.raw_product_id,
      h.finished_product_id,
      h.source_count,
      h.initial_quantity,
      COALESCE(r.incoming_quantity, 0)::bigint AS incoming_quantity,
      (
        COALESCE(r.consumed_quantity, 0)
        + COALESCE(s.consumed_quantity, 0)
      )::numeric AS consumed_quantity,
      (
        COALESCE(r.reserved_quantity, 0)
        + COALESCE(s.reserved_quantity, 0)
      )::numeric AS reserved_quantity,
      (
        COALESCE(r.incoming_quantity, 0)
        - COALESCE(r.consumed_quantity, 0)
        - COALESCE(s.consumed_quantity, 0)
      )::numeric AS available_quantity,
      (
        COALESCE(r.incoming_quantity, 0)
        - COALESCE(r.consumed_quantity, 0)
        - COALESCE(s.consumed_quantity, 0)
        - COALESCE(r.reserved_quantity, 0)
        - COALESCE(s.reserved_quantity, 0)
      )::numeric AS projected_available_quantity,
      h.source_statuses,
      CASE
        WHEN COALESCE(r.incoming_quantity, 0) = 0 THEN 'pending_receipt'
        WHEN COALESCE(r.incoming_quantity, 0)
          - COALESCE(r.consumed_quantity, 0)
          - COALESCE(s.consumed_quantity, 0) <= 0 THEN 'unavailable'
        WHEN COALESCE(r.incoming_quantity, 0)
          - COALESCE(r.consumed_quantity, 0)
          - COALESCE(s.consumed_quantity, 0)
          - COALESCE(r.reserved_quantity, 0)
          - COALESCE(s.reserved_quantity, 0) <= 0 THEN 'reserved'
        WHEN COALESCE(r.reserved_quantity, 0)
          + COALESCE(s.reserved_quantity, 0) > 0 THEN 'partially_reserved'
        ELSE 'available'
      END AS availability_status,
      GREATEST(h.recorded_at, r.recorded_at) AS recorded_at
    FROM harvest_lots h
    LEFT JOIN receipt_inventory r
      ON r.lot_number = h.lot_number
      AND r.raw_product_id IS NOT DISTINCT FROM h.raw_product_id
      AND r.finished_product_id IS NOT DISTINCT FROM h.finished_product_id
    LEFT JOIN sales_usage s
      ON s.lot_source = 'harvesting_tracking'
      AND s.lot_number = h.lot_number
      AND s.finished_product_id = h.finished_product_id
  ),
  production_journal AS (
    SELECT
      o.output_lot_number::text AS lot_number,
      'production_outputs'::text AS lot_source,
      o.raw_product_id,
      o.finished_product_id,
      1::int AS source_count,
      o.produced_boxes::bigint AS initial_quantity,
      CASE
        WHEN p.status = 'completed' THEN o.produced_boxes
        ELSE 0
      END::bigint AS incoming_quantity,
      CASE
        WHEN p.status = 'completed' THEN
          COALESCE(u.consumed_quantity, 0)
          + COALESCE(s.consumed_quantity, 0)
        ELSE 0
      END::numeric AS consumed_quantity,
      CASE
        WHEN p.status = 'completed' THEN
          COALESCE(u.reserved_quantity, 0)
          + COALESCE(s.reserved_quantity, 0)
        ELSE 0
      END::numeric AS reserved_quantity,
      CASE
        WHEN p.status = 'completed'
          THEN o.produced_boxes
            - COALESCE(u.consumed_quantity, 0)
            - COALESCE(s.consumed_quantity, 0)
        ELSE 0
      END::numeric AS available_quantity,
      CASE
        WHEN p.status = 'completed'
          THEN o.produced_boxes
            - COALESCE(u.consumed_quantity, 0)
            - COALESCE(s.consumed_quantity, 0)
            - COALESCE(u.reserved_quantity, 0)
            - COALESCE(s.reserved_quantity, 0)
        ELSE 0
      END::numeric AS projected_available_quantity,
      ARRAY[p.status]::text[] AS source_statuses,
      CASE
        WHEN p.status = 'cancelled' THEN 'cancelled'
        WHEN p.status = 'in_progress' THEN 'in_progress'
        WHEN o.produced_boxes
          - COALESCE(u.consumed_quantity, 0)
          - COALESCE(s.consumed_quantity, 0) <= 0
          THEN 'unavailable'
        WHEN o.produced_boxes
          - COALESCE(u.consumed_quantity, 0)
          - COALESCE(s.consumed_quantity, 0)
          - COALESCE(u.reserved_quantity, 0)
          - COALESCE(s.reserved_quantity, 0) <= 0 THEN 'reserved'
        WHEN COALESCE(u.reserved_quantity, 0)
          + COALESCE(s.reserved_quantity, 0) > 0 THEN 'partially_reserved'
        ELSE 'available'
      END AS availability_status,
      COALESCE(o.created_at, p.production_date::timestamp) AS recorded_at
    FROM trackability.production_outputs o
    JOIN trackability.productions p
      ON p.id = o.production_id
    LEFT JOIN source_usage u
      ON u.lot_source = 'production_outputs'
      AND u.source_id = o.id
    LEFT JOIN sales_usage s
      ON s.lot_source = 'production_outputs'
      AND s.lot_number = o.output_lot_number
      AND s.finished_product_id = o.finished_product_id
    WHERE o.output_lot_number IS NOT NULL
      AND (o.raw_product_id IS NULL) <> (o.finished_product_id IS NULL)
  ),
  lot_inventory AS (
    SELECT * FROM harvest_journal
    UNION ALL
    SELECT * FROM production_journal
  ),
  journal AS (
    SELECT
      li.lot_number,
      li.lot_source,
      CASE
        WHEN li.raw_product_id IS NOT NULL THEN 'raw_product'
        ELSE 'finished_product'
      END AS product_source,
      COALESCE(li.raw_product_id, li.finished_product_id) AS product_id,
      COALESCE(rp.product_code::text, fp.product_code::text) AS product_code,
      COALESCE(rp.description::text, fp.full_name::text) AS product_name,
      li.source_count,
      li.initial_quantity,
      li.incoming_quantity,
      li.consumed_quantity,
      li.reserved_quantity,
      li.available_quantity,
      li.projected_available_quantity,
      (li.available_quantity > 0) AS is_available,
      (li.projected_available_quantity > 0) AS is_projected_available,
      li.availability_status,
      li.source_statuses,
      li.recorded_at
    FROM lot_inventory li
    LEFT JOIN public.raw_product rp
      ON rp.id = li.raw_product_id
    LEFT JOIN public.finished_product fp
      ON fp.id = li.finished_product_id
  )
  SELECT *
  FROM journal
  WHERE (
      $1::text = ''
      OR lot_number ILIKE '%' || $1 || '%'
      OR product_code ILIKE '%' || $1 || '%'
      OR product_name ILIKE '%' || $1 || '%'
    )
    AND ($2::text IS NULL OR product_source = $2)
    AND ($3::boolean IS NULL OR is_available = $3)
    AND (
      $4::int IS NULL
      OR (
        recorded_at >= make_date($4::int, 1, 1)
        AND recorded_at < make_date($4::int + 1, 1, 1)
      )
    )
    AND ($5::int IS NULL OR product_id = $5)
    AND ($6::boolean IS NULL OR is_projected_available = $6)
  ORDER BY recorded_at DESC NULLS LAST, lot_number DESC, lot_source
`;

/**
 * GET /trackability/lot-numbers
 *
 * Optional filters:
 *   q=lot/product text
 *   productSource=raw_product|finished_product
 *   available=true|false
 *   year=YYYY (defaults to the current year)
 */
router.get("/", readRoles, async (req, res) => {
  const query = getQueryText(req.query.q);
  const productSource = getProductSource(req.query.productSource);
  const available = getAvailability(req.query.available);
  const year = getYear(req.query.year);

  if (query === null) {
    return res.status(400).json({
      error: "q must be a string of at most 100 characters",
    });
  }
  if (productSource === undefined) {
    return res.status(400).json({
      error: "productSource must be raw_product or finished_product",
    });
  }
  if (available === undefined) {
    return res.status(400).json({
      error: "available must be true or false",
    });
  }
  if (year === undefined) {
    return res.status(400).json({
      error: "year must be a four-digit year between 2000 and 2100",
    });
  }

  try {
    await ensureSalesLotAllocationsTable();
    const { rows } = await pool.query(lotJournalSql, [
      query,
      productSource,
      available,
      year,
      null,
      null,
    ]);
    return res.status(200).json(rows);
  } catch (error) {
    console.error("Lot journal database error:", error);
    return res.status(500).json({ error: "Failed to fetch lot journal" });
  }
});

export default router;
