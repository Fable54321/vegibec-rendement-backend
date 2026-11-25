import { Router, type RequestHandler, type Response } from "express";
import type { Pool, PoolClient } from "pg";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user", "guest"]);
const overrideRoles = requireAppRole("main", ["admin"]);
const LABELS_PER_PALLET = 2;
const MAX_INT = 2147483647;

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function positiveId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  const text = String(value);
  if (!/^[1-9]\d{0,18}$/.test(text)) return null;
  return BigInt(text) <= 9223372036854775807n ? text : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_INT
    ? value
    : null;
}

function sendDatabaseError(res: Response, error: unknown) {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === "P0001") {
    return res
      .status(409)
      .json({
        error: error instanceof Error ? error.message : "Reception rejected",
      });
  }
  if (["23505", "23503", "40001", "40P01"].includes(code ?? "")) {
    return res
      .status(409)
      .json({
        error:
          "Reception conflicts with existing records or another transaction",
      });
  }
  if (["23514", "23502", "22003", "22001", "22P02"].includes(code ?? "")) {
    return res.status(400).json({ error: "Invalid reception data" });
  }
  console.error("Harvest receipts database error:", error);
  return res.status(500).json({ error: "Database operation failed" });
}

async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await db.query("SELECT pg_advisory_xact_lock(7142, 1)");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackError) {
      discard = true;
      console.error("Harvest receipt rollback failed:", rollbackError);
    }
    throw error;
  } finally {
    db.release(discard);
  }
}

// Only posted receptions count toward received quantities.
const postedReceivedSql = `
  SELECT e.harvesting_id, SUM(e.received_boxes)::bigint AS received_boxes
  FROM trackability.harvest_receipt_entries e
  WHERE EXISTS (
    SELECT 1 FROM trackability.lot_movements lm
    WHERE lm.receipt_id = e.receipt_id
      AND lm.movement_type = 'harvest_receipt'
  )
  GROUP BY e.harvesting_id
`;

const productColumns = `
  l.product_id AS product_reference_id,
  pr.raw_product_id,
  pr.finished_product_id,
  CASE WHEN pr.raw_product_id IS NOT NULL THEN 'raw_product'
       ELSE 'finished_product' END AS product_source,
  COALESCE(pr.raw_product_id, pr.finished_product_id) AS source_product_id
`;

const receiptColumns = `
  r.id::text AS id,
  r.lot_id::text AS lot_id,
  l.lot_number AS harvest_lot_number,
  r.received_by_user_id,
  r.number_of_pallets,
  r.labels_per_pallet,
  (r.number_of_pallets * r.labels_per_pallet) AS number_of_labels,
  r.received_at,
  r.created_at,
  ${productColumns},
  COALESCE(t.total_received_boxes, 0)::bigint AS total_received_boxes,
  COALESCE(t.harvesting_entry_count, 0)::integer AS harvesting_entry_count,
  m.id::text AS movement_id,
  (m.id IS NOT NULL) AS is_posted,
  m.notes AS posting_notes
`;
const receiptFrom = `
  FROM trackability.harvest_receipts r
  JOIN trackability.lots l ON l.id = r.lot_id
  JOIN trackability.product_reference pr ON pr.id = l.product_id
  LEFT JOIN LATERAL (
    SELECT SUM(e.received_boxes) AS total_received_boxes,
           COUNT(*) AS harvesting_entry_count
    FROM trackability.harvest_receipt_entries e
    WHERE e.receipt_id = r.id
  ) t ON TRUE
  LEFT JOIN trackability.lot_movements m
    ON m.receipt_id = r.id AND m.movement_type = 'harvest_receipt'
`;

// Preserve numeric receipt totals for existing frontend consumers.
// A posted receipt's total must fit the INTEGER ledger delta.
function receiptResponse(row: Record<string, any>) {
  const total = Number(row.total_received_boxes);
  return {
    ...row,
    total_received_boxes: Number.isSafeInteger(total)
      ? total
      : row.total_received_boxes,
  };
}

async function readReceipt(db: Pool | PoolClient, id: string) {
  const { rows } = await db.query(
    `
    SELECT ${receiptColumns},
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'harvesting_id', h.id::text,
          'received_boxes', e.received_boxes,
          'harvesting_date', h.harvesting_date,
          'field_id', h.field_id,
          'vegetable_id', h.vegetable_id,
          'product_id', l.product_id,
          'product_reference_id', l.product_id,
          'raw_product_id', pr.raw_product_id::text,
          'finished_product_id', pr.finished_product_id,
          'product_source', CASE WHEN pr.raw_product_id IS NOT NULL
            THEN 'raw_product' ELSE 'finished_product' END,
          'source_product_id', COALESCE(pr.raw_product_id, pr.finished_product_id)::text,
          'box_type_id', h.box_type_id
        ) ORDER BY h.id)
        FROM trackability.harvest_receipt_entries e
        JOIN trackability.harvesting_tracking h ON h.id = e.harvesting_id
        WHERE e.receipt_id = r.id
      ), '[]'::jsonb) AS harvesting_entries
    ${receiptFrom}
    WHERE r.id = $1
  `,
    [id],
  );
  if (!rows.length) throw new HttpError(404, "Receipt not found");
  return receiptResponse(rows[0]);
}

// GET /available — individual trailers with boxes remaining to receive.
router.get("/available", readRoles, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.id::text AS id,
        h.lot_id::text AS lot_id,
        l.lot_number AS harvest_lot_number,
        h.field_id, h.vegetable_id, l.product_id,
        h.team_leader_user_id, ${productColumns},
        h.box_type_id, h.harvesting_date, h.harvesting_time,
        h.finalized_at, h.received_at, h.amount_of_boxes,
        COALESCE(received.received_boxes, 0)::integer AS already_received_boxes,
        (h.amount_of_boxes - COALESCE(received.received_boxes, 0))::integer AS remaining_boxes
      FROM trackability.harvesting_tracking h
      JOIN trackability.lots l ON l.id = h.lot_id
      JOIN trackability.product_reference pr ON pr.id = l.product_id
      LEFT JOIN (${postedReceivedSql}) received ON received.harvesting_id = h.id
      WHERE h.status = 'finalized'
        AND l.lot_type = 'harvest'
        AND h.received_at IS NULL
        AND h.amount_of_boxes > COALESCE(received.received_boxes, 0)
      ORDER BY h.finalized_at DESC NULLS LAST, h.id DESC
    `);
    return res.json(rows);
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

// GET / — recent receipts (including any unposted records, clearly flagged).
router.get("/", readRoles, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ${receiptColumns}
      ${receiptFrom}
      ORDER BY r.received_at DESC, r.id DESC
      LIMIT 200
    `);
    return res.json(rows.map(receiptResponse));
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

router.get("/:id", readRoles, async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id || BigInt(id) > BigInt(MAX_INT))
    return res.status(400).json({ error: "Invalid receipt id" });
  try {
    return res.json(await readReceipt(pool, id));
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

// Excess receipt authorization is enforced on the server, not by a client flag alone.
const authorizeOverride: RequestHandler = (req, res, next) => {
  if (req.body?.allow_excess === true) return overrideRoles(req, res, next);
  next();
};

// POST / — atomically create and post one reception.
router.post("/", writeRoles, authorizeOverride, async (req, res) => {
  const numberOfLabels = positiveInt(req.body?.number_of_labels);
  if (!numberOfLabels)
    return res
      .status(400)
      .json({ error: "number_of_labels must be a positive integer" });
  if (numberOfLabels !== 1 && numberOfLabels % LABELS_PER_PALLET !== 0) {
    return res
      .status(400)
      .json({
        error: `number_of_labels must be 1 or a multiple of ${LABELS_PER_PALLET}`,
      });
  }
  const labelsPerPallet = numberOfLabels === 1 ? 1 : LABELS_PER_PALLET;
  const numberOfPallets = numberOfLabels / labelsPerPallet;
  const rawEntries: unknown = req.body?.harvesting_entries;
  if (
    !Array.isArray(rawEntries) ||
    rawEntries.length === 0 ||
    rawEntries.length > 500
  ) {
    return res
      .status(400)
      .json({ error: "harvesting_entries must contain 1 to 500 entries" });
  }

  const entries: { harvestingId: string; receivedBoxes: number }[] = [];
  for (const entry of rawEntries) {
    const harvestingId = positiveId(entry?.harvesting_id);
    const receivedBoxes = positiveInt(entry?.received_boxes);
    if (!harvestingId || !receivedBoxes) {
      return res
        .status(400)
        .json({
          error:
            "Each entry needs a valid harvesting_id and positive received_boxes",
        });
    }
    entries.push({ harvestingId, receivedBoxes });
  }
  if (new Set(entries.map((e) => e.harvestingId)).size !== entries.length) {
    return res
      .status(400)
      .json({ error: "Duplicate harvesting_id in request" });
  }
  const total = entries.reduce((sum, e) => sum + e.receivedBoxes, 0);
  if (total > MAX_INT)
    return res
      .status(400)
      .json({ error: "Total received boxes exceeds database limit" });

  const rawOverride = req.body?.allow_excess;
  if (rawOverride !== undefined && typeof rawOverride !== "boolean") {
    return res.status(400).json({ error: "allow_excess must be a boolean" });
  }
  const allowExcess = rawOverride === true;
  const rawNotes = req.body?.notes;
  if (rawNotes != null && typeof rawNotes !== "string") {
    return res.status(400).json({ error: "notes must be a string" });
  }
  const notes = typeof rawNotes === "string" ? rawNotes.trim() || null : null;
  if (allowExcess && !notes)
    return res
      .status(400)
      .json({ error: "Notes are required for an excess receipt override" });

  const authUser = (req as typeof req & { user?: { id?: unknown } }).user;
  const userId = positiveId(authUser?.id);
  if (!userId || BigInt(userId) > BigInt(MAX_INT)) {
    return res.status(401).json({ error: "Authenticated user required" });
  }

  try {
    const receipt = await transaction(async (db) => {
      const ids = entries.map((e) => e.harvestingId);
      const harvestResult = await db.query(
        `
        SELECT h.id::text AS id, h.lot_id::text AS lot_id,
          h.status, h.received_at, h.amount_of_boxes, l.lot_type
        FROM trackability.harvesting_tracking h
        JOIN trackability.lots l ON l.id = h.lot_id
        WHERE h.id = ANY($1::bigint[])
        ORDER BY h.id
        FOR UPDATE OF h
      `,
        [ids],
      );
      if (harvestResult.rows.length !== entries.length) {
        throw new HttpError(400, "One or more harvesting records do not exist");
      }
      const lotIds = new Set<string>();
      for (const h of harvestResult.rows) {
        if (h.status !== "finalized" || h.lot_type !== "harvest") {
          throw new HttpError(
            409,
            `Harvest ${h.id} is not a finalized harvest lot`,
          );
        }
        if (h.received_at !== null) {
          throw new HttpError(
            409,
            `Harvest ${h.id} was already fully received`,
          );
        }
        lotIds.add(h.lot_id);
      }
      if (lotIds.size !== 1)
        throw new HttpError(
          400,
          "All harvesting entries must share the same lot number",
        );
      const lotId = harvestResult.rows[0].lot_id;

      const inserted = await db.query(
        `
        INSERT INTO trackability.harvest_receipts
          (lot_id, received_by_user_id, number_of_pallets, labels_per_pallet)
        VALUES ($1, $2, $3, $4)
        RETURNING id::text AS id, received_at
      `,
        [lotId, userId, numberOfPallets, labelsPerPallet],
      );
      const receiptId = inserted.rows[0].id;
      const receivedAt = inserted.rows[0].received_at;

      await db.query(
        `
        INSERT INTO trackability.harvest_receipt_entries
          (receipt_id, harvesting_id, received_boxes)
        SELECT $1::integer, x.harvesting_id, x.received_boxes
        FROM unnest($2::bigint[], $3::integer[]) AS x(harvesting_id, received_boxes)
      `,
        [receiptId, ids, entries.map((e) => e.receivedBoxes)],
      );

      // Database function is responsible for cumulative quantity validation,
      // documented overrides and immutable ledger posting.
      await db.query(
        `
        SELECT trackability.post_harvest_receipt(
          $1::bigint, $2::integer, $3::boolean, $4::text
        )
      `,
        [receiptId, userId, allowExcess, notes],
      );

      // Mark a trailer fully received only after posting the ledger movement.
      await db.query(
        `
        UPDATE trackability.harvesting_tracking h
        SET received_at = $2::timestamptz
        FROM (${postedReceivedSql}) received
        WHERE h.id = ANY($1::bigint[])
          AND h.id = received.harvesting_id
          AND h.received_at IS NULL
          AND received.received_boxes >= h.amount_of_boxes
      `,
        [ids, receivedAt],
      );

      return readReceipt(db, receiptId);
    });
    return res.status(201).json(receipt);
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

// GET /:id/labels — print metadata, only for posted receipts.
router.get("/:id/labels", readRoles, async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id || BigInt(id) > BigInt(MAX_INT))
    return res.status(400).json({ error: "Invalid receipt id" });
  try {
    const { rows } = await pool.query(
      `
      SELECT r.id::text AS receipt_id,
        r.lot_id::text AS lot_id,
        l.lot_number AS harvest_lot_number,
        r.number_of_pallets, r.labels_per_pallet,
        (r.number_of_pallets * r.labels_per_pallet) AS number_of_labels,
        EXISTS (SELECT 1 FROM trackability.lot_movements lm
          WHERE lm.receipt_id = r.id AND lm.movement_type = 'harvest_receipt') AS is_posted
      FROM trackability.harvest_receipts r
      JOIN trackability.lots l ON l.id = r.lot_id
      WHERE r.id = $1
    `,
      [id],
    );
    if (!rows.length)
      return res.status(404).json({ error: "Receipt not found" });
    if (!rows[0].is_posted)
      return res.status(409).json({ error: "Receipt has not been posted" });
    return res.json(rows[0]);
  } catch (error) {
    return sendDatabaseError(res, error);
  }
});

export default router;
