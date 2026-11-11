import { Router, type Request, type Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

/**
 * Mount at /production (or your preferred prefix).
 * Assumes the three production tables from the agreed SQL, plus:
 * trackability.harvest_receipts, trackability.receipt_items,
 * trackability.harvesting_tracking (product_id = public.raw_product.id).
 *
 * Inventory is derived: incoming boxes minus inputs of COMPLETED productions.
 * Draft edits do NOT change stock. Negative balances are allowed and warned about.
 * All quantity values are boxes, not pallets.
 */
const router = Router();
const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user"]); // change to your production app slug if applicable

type ProductRef = {
  raw_product_id: number | null;
  finished_product_id: number | null;
};
type InputSource = {
  receipt_id: number | null;
  source_production_output_id: number | null;
};
type ProductionStatus = "in_progress" | "completed" | "cancelled";

class HttpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v);
const positive = (v: unknown): v is number => integer(v) && v > 0;
const nonnegative = (v: unknown): v is number => integer(v) && v >= 0;
const idParam = (v: unknown) => {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new HttpError(400, "Invalid ID");
  return id;
};
function productRef(value: unknown): ProductRef {
  if (!value || typeof value !== "object")
    throw new HttpError(400, "Product is required");
  const data = value as Record<string, unknown>;
  const raw = data.raw_product_id ?? null;
  const finished = data.finished_product_id ?? null;
  if (
    (raw === null) === (finished === null) ||
    (raw !== null && !positive(raw)) ||
    (finished !== null && !positive(finished))
  ) {
    throw new HttpError(
      400,
      "Provide exactly one valid raw_product_id or finished_product_id",
    );
  }
  return {
    raw_product_id: raw as number | null,
    finished_product_id: finished as number | null,
  };
}
function inputSource(value: unknown): InputSource {
  if (!value || typeof value !== "object")
    throw new HttpError(400, "Input source is required");
  const data = value as Record<string, unknown>;
  const receipt = data.receipt_id ?? null;
  const output = data.source_production_output_id ?? null;
  if (
    (receipt === null) === (output === null) ||
    (receipt !== null && !positive(receipt)) ||
    (output !== null && !positive(output))
  ) {
    throw new HttpError(
      400,
      "Provide exactly one valid receipt_id or source_production_output_id",
    );
  }
  return {
    receipt_id: receipt as number | null,
    source_production_output_id: output as number | null,
  };
}
function getDate(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))
    throw new HttpError(400, "production_date must be YYYY-MM-DD");
  const date = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== v)
    throw new HttpError(400, "Invalid production_date");
  return v;
}
// ISO 8601 week-year, week 01-53, Monday=1 ... Sunday=7.
// The caller provides the full lot, since the real PPPP product-code column is not known.
function isoLotPrefix(dateString: string): string {
  const d = new Date(`${dateString}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 4 - day);
  const year = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${String(year).slice(-2)}${String(week).padStart(2, "0")}${day}`;
}
function validateLot(v: unknown, date: string): string {
  if (typeof v !== "string" || !/^\d{9}$/.test(v))
    throw new HttpError(400, "output_lot_number must be 9 digits: YYWWDPPPP");
  if (!v.startsWith(isoLotPrefix(date)))
    throw new HttpError(
      400,
      `Output lot must start with ${isoLotPrefix(date)} for ${date} (ISO week, Monday=1)`,
    );
  return v;
}
async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
function respondError(res: Response, error: unknown) {
  if (error instanceof HttpError)
    return res.status(error.code).json({ error: error.message });
  const pg = error as { code?: string; constraint?: string };
  if (pg.code === "23505")
    return res
      .status(409)
      .json({
        error: "Duplicate production input or output lot number",
        constraint: pg.constraint,
      });
  if (pg.code === "23503")
    return res
      .status(400)
      .json({
        error: "Referenced record does not exist",
        constraint: pg.constraint,
      });
  if (pg.code === "23514")
    return res
      .status(400)
      .json({ error: "Database constraint failed", constraint: pg.constraint });
  console.error("Production API error", error);
  return res.status(500).json({ error: "Internal server error" });
}
function route(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((err) => respondError(res, err));
  };
}
async function lockedDraft(db: PoolClient, id: number) {
  const { rows } = await db.query(
    "SELECT * FROM trackability.productions WHERE id = $1 FOR UPDATE",
    [id],
  );
  const production = rows[0];
  if (!production) throw new HttpError(404, "Production not found");
  if (production.status !== "in_progress")
    throw new HttpError(409, "Production must be in_progress to edit");
  return production;
}

// A receiving record can contain entries, but all must belong to ONE raw product.
// Never trust a product ID supplied by the client for an input: derive it from source.
async function resolveSource(
  db: PoolClient,
  source: InputSource,
  productionId: number,
): Promise<ProductRef> {
  if (source.receipt_id !== null) {
    const { rows } = await db.query(
      `
      SELECT r.id, COUNT(DISTINCT h.product_id)::int AS product_count,
             MIN(h.product_id)::int AS raw_product_id,
             COALESCE(SUM(ri.received_boxes), 0)::bigint AS received_boxes
      FROM trackability.harvest_receipts r
      LEFT JOIN trackability.receipt_items ri ON ri.receipt_id = r.id
      LEFT JOIN trackability.harvesting_tracking h ON h.id = ri.harvesting_id
      WHERE r.id = $1
      GROUP BY r.id
    `,
      [source.receipt_id],
    );
    if (!rows[0]) throw new HttpError(404, "Receipt not found");
    if (rows[0].product_count !== 1 || rows[0].raw_product_id === null) {
      throw new HttpError(
        409,
        "Receipt must contain harvesting entries for exactly one raw product",
      );
    }
    return {
      raw_product_id: rows[0].raw_product_id,
      finished_product_id: null,
    };
  }
  const { rows } = await db.query(
    `
    SELECT o.id, o.production_id, o.raw_product_id, o.finished_product_id,
           p.status
    FROM trackability.production_outputs o
    JOIN trackability.productions p ON p.id = o.production_id
    WHERE o.id = $1
  `,
    [source.source_production_output_id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "Source production output not found");
  if (row.production_id === productionId)
    throw new HttpError(400, "A production cannot consume its own output");
  if (row.status !== "completed")
    throw new HttpError(
      409,
      "Source production must be completed before it can be used",
    );
  return {
    raw_product_id: row.raw_product_id,
    finished_product_id: row.finished_product_id,
  };
}

async function readProduction(db: Pick<PoolClient, "query">, id: number) {
  const p = await db.query(
    "SELECT * FROM trackability.productions WHERE id = $1",
    [id],
  );
  if (!p.rows.length) throw new HttpError(404, "Production not found");
  const [inputs, outputs] = await Promise.all([
    db.query(
      `
      SELECT pi.*, r.harvest_lot_number AS input_harvest_lot_number,
             src.output_lot_number AS input_production_lot_number
      FROM trackability.production_inputs pi
      LEFT JOIN trackability.harvest_receipts r ON r.id = pi.receipt_id
      LEFT JOIN trackability.production_outputs src ON src.id = pi.source_production_output_id
      WHERE pi.production_id = $1 ORDER BY pi.id
    `,
      [id],
    ),
    db.query(
      "SELECT * FROM trackability.production_outputs WHERE production_id = $1",
      [id],
    ),
  ]);
  return { ...p.rows[0], inputs: inputs.rows, output: outputs.rows[0] ?? null };
}

// Return balance for each receipt and each completed production output.
// Open productions are shown separately as provisional usage (not deducted).
const inventorySQL = `
WITH receipt_stock AS (
  SELECT r.id AS source_id, 'receipt'::text AS source_type,
         r.harvest_lot_number AS lot_number,
         MIN(h.product_id)::int AS raw_product_id, NULL::int AS finished_product_id,
         COUNT(DISTINCT h.product_id)::int AS product_count,
         COALESCE(SUM(ri.received_boxes),0)::bigint AS incoming_boxes
  FROM trackability.harvest_receipts r
  JOIN trackability.receipt_items ri ON ri.receipt_id = r.id
  JOIN trackability.harvesting_tracking h ON h.id = ri.harvesting_id
  GROUP BY r.id, r.harvest_lot_number
  HAVING COUNT(DISTINCT h.product_id) = 1
),
output_stock AS (
  SELECT o.id AS source_id, 'production_output'::text AS source_type,
         o.output_lot_number AS lot_number,
         o.raw_product_id, o.finished_product_id,
         1 AS product_count, o.produced_boxes::bigint AS incoming_boxes
  FROM trackability.production_outputs o
  JOIN trackability.productions p ON p.id = o.production_id
  WHERE p.status = 'completed'
),
sources AS (
  SELECT * FROM receipt_stock UNION ALL SELECT * FROM output_stock
),
usage AS (
  SELECT CASE WHEN pi.receipt_id IS NOT NULL THEN 'receipt' ELSE 'production_output' END AS source_type,
         COALESCE(pi.receipt_id, pi.source_production_output_id) AS source_id,
         COALESCE(SUM(pi.used_boxes) FILTER (WHERE p.status = 'completed'),0)::bigint AS consumed_boxes,
         COALESCE(SUM(pi.used_boxes) FILTER (WHERE p.status = 'in_progress'),0)::bigint AS open_boxes
  FROM trackability.production_inputs pi
  JOIN trackability.productions p ON p.id = pi.production_id
  WHERE p.status <> 'cancelled'
  GROUP BY 1,2
)
SELECT s.source_id, s.source_type, s.lot_number,
       s.raw_product_id, s.finished_product_id,
       s.incoming_boxes, COALESCE(u.consumed_boxes,0)::bigint AS consumed_boxes,
       COALESCE(u.open_boxes,0)::bigint AS open_boxes,
       (s.incoming_boxes - COALESCE(u.consumed_boxes,0))::bigint AS available_boxes,
       (s.incoming_boxes - COALESCE(u.consumed_boxes,0) - COALESCE(u.open_boxes,0))::bigint AS projected_boxes
FROM sources s
LEFT JOIN usage u ON u.source_type = s.source_type AND u.source_id = s.source_id
`;

router.get(
  "/available-inputs",
  readRoles,
  route(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const { rows } = await pool.query(
      `
    SELECT * FROM (${inventorySQL}) inventory
    WHERE ($1::text = '' OR lot_number ILIKE '%' || $1 || '%')
    ORDER BY lot_number DESC, source_type, source_id
    LIMIT 500
  `,
      [q],
    );
    // The UI can GROUP BY lot_number; a lot can have multiple distinct receipt IDs.
    res.json(rows);
  }),
);

router.get(
  "/",
  readRoles,
  route(async (req, res) => {
    const status =
      typeof req.query.status === "string" ? req.query.status : null;
    if (status && !["in_progress", "completed", "cancelled"].includes(status))
      throw new HttpError(400, "Invalid status");
    const { rows } = await pool.query(
      `
    SELECT p.*, o.id AS output_id, o.output_lot_number, o.raw_product_id,
           o.finished_product_id, o.produced_boxes, o.number_of_pallets
    FROM trackability.productions p
    LEFT JOIN trackability.production_outputs o ON o.production_id = p.id
    WHERE ($1::text IS NULL OR p.status = $1)
    ORDER BY p.production_date DESC, p.id DESC LIMIT 200
  `,
      [status],
    );
    res.json(rows);
  }),
);
router.get(
  "/:id",
  readRoles,
  route(async (req, res) => {
    res.json(await readProduction(pool, idParam(req.params.id)));
  }),
);

// POST /  { description?, production_date: 'YYYY-MM-DD' }
router.post(
  "/",
  writeRoles,
  route(async (req, res) => {
    const date = getDate(req.body?.production_date);
    const description = req.body?.description ?? null;
    if (
      description !== null &&
      (typeof description !== "string" || description.length > 255)
    )
      throw new HttpError(400, "description must be 255 characters or fewer");
    const { rows } = await pool.query(
      `
    INSERT INTO trackability.productions (description, production_date)
    VALUES ($1, $2) RETURNING *
  `,
      [description, date],
    );
    res.status(201).json(rows[0]);
  }),
);

// PATCH /:id { description?, production_date? } - date cannot change after an output exists.
router.patch(
  "/:id",
  writeRoles,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const result = await transaction(async (db) => {
      const existing = await lockedDraft(db, id);
      const description =
        req.body?.description === undefined
          ? existing.description
          : req.body.description;
      if (
        description !== null &&
        (typeof description !== "string" || description.length > 255)
      )
        throw new HttpError(400, "Invalid description");
      const date =
        req.body?.production_date === undefined
          ? String(
              existing.production_date instanceof Date
                ? existing.production_date.toISOString().slice(0, 10)
                : existing.production_date,
            )
          : getDate(req.body.production_date);
      const output = await db.query(
        "SELECT 1 FROM trackability.production_outputs WHERE production_id = $1",
        [id],
      );
      if (
        output.rowCount &&
        req.body?.production_date !== undefined &&
        date !==
          String(
            existing.production_date instanceof Date
              ? existing.production_date.toISOString().slice(0, 10)
              : existing.production_date,
          )
      ) {
        throw new HttpError(
          409,
          "Remove the output before changing production_date",
        );
      }
      const { rows } = await db.query(
        `UPDATE trackability.productions SET description=$2, production_date=$3 WHERE id=$1 RETURNING *`,
        [id, description, date],
      );
      return rows[0];
    });
    res.json(result);
  }),
);

// PUT /:id/inputs - replace ALL draft inputs atomically.
// Body: { inputs: [{ receipt_id: 10, used_boxes: 30 },
//                  { source_production_output_id: 3, used_boxes: 15 }] }
router.put(
  "/:id/inputs",
  writeRoles,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const inputs: unknown = req.body?.inputs;
    if (!Array.isArray(inputs) || inputs.length > 200)
      throw new HttpError(400, "inputs must be an array of at most 200 items");
    const normalized = inputs.map((value: unknown) => {
      const source = inputSource(value);
      const quantity = (value as Record<string, unknown>).used_boxes;
      if (!nonnegative(quantity))
        throw new HttpError(400, "used_boxes must be a nonnegative integer");
      return { ...source, used_boxes: quantity };
    });
    const unique = new Set(
      normalized.map((x) =>
        x.receipt_id !== null
          ? `r:${x.receipt_id}`
          : `o:${x.source_production_output_id}`,
      ),
    );
    if (unique.size !== normalized.length)
      throw new HttpError(400, "Duplicate input source in request");
    const result = await transaction(async (db) => {
      await lockedDraft(db, id);
      const enriched = [];
      for (const input of normalized) {
        const product = await resolveSource(db, input, id);
        enriched.push({ ...input, ...product });
      }
      await db.query(
        "DELETE FROM trackability.production_inputs WHERE production_id = $1",
        [id],
      );
      for (const i of enriched) {
        await db.query(
          `
        INSERT INTO trackability.production_inputs
          (production_id, receipt_id, source_production_output_id, raw_product_id, finished_product_id, used_boxes)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
          [
            id,
            i.receipt_id,
            i.source_production_output_id,
            i.raw_product_id,
            i.finished_product_id,
            i.used_boxes,
          ],
        );
      }
      return readProduction(db, id);
    });
    res.json(result);
  }),
);

// PUT /:id/output - exactly one output lot per production.
// Body: { raw_product_id: null, finished_product_id: 12,
//         output_lot_number: '264530123', produced_boxes: 90, number_of_pallets: 2 }
// IMPORTANT: PPPP must come from your actual product-code catalogue.
router.put(
  "/:id/output",
  writeRoles,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const product = productRef(req.body);
    const boxes = req.body?.produced_boxes;
    const pallets = req.body?.number_of_pallets;
    if (!nonnegative(boxes) || !nonnegative(pallets))
      throw new HttpError(
        400,
        "produced_boxes and number_of_pallets must be nonnegative integers",
      );
    const result = await transaction(async (db) => {
      const production = await lockedDraft(db, id);
      const date =
        production.production_date instanceof Date
          ? production.production_date.toISOString().slice(0, 10)
          : String(production.production_date);
      const lot = validateLot(req.body?.output_lot_number, date);
      const old = await db.query(
        "SELECT * FROM trackability.production_outputs WHERE production_id=$1 FOR UPDATE",
        [id],
      );
      if (old.rows.length) {
        const used = await db.query(
          "SELECT 1 FROM trackability.production_inputs WHERE source_production_output_id = $1 LIMIT 1",
          [old.rows[0].id],
        );
        if (
          used.rowCount &&
          (old.rows[0].output_lot_number !== lot ||
            old.rows[0].raw_product_id !== product.raw_product_id ||
            old.rows[0].finished_product_id !== product.finished_product_id)
        ) {
          throw new HttpError(
            409,
            "Output is used downstream; its lot and product cannot be changed",
          );
        }
      }
      const { rows } = await db.query(
        `
      INSERT INTO trackability.production_outputs
        (production_id, raw_product_id, finished_product_id, output_lot_number, produced_boxes, number_of_pallets)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (production_id) DO UPDATE SET
        raw_product_id=EXCLUDED.raw_product_id,
        finished_product_id=EXCLUDED.finished_product_id,
        output_lot_number=EXCLUDED.output_lot_number,
        produced_boxes=EXCLUDED.produced_boxes,
        number_of_pallets=EXCLUDED.number_of_pallets
      RETURNING *
    `,
        [
          id,
          product.raw_product_id,
          product.finished_product_id,
          lot,
          boxes,
          pallets,
        ],
      );
      return rows[0];
    });
    res.json(result);
  }),
);

// DELETE /:id/output - allowed only while draft AND not referenced downstream.
router.delete(
  "/:id/output",
  writeRoles,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    await transaction(async (db) => {
      await lockedDraft(db, id);
      const { rows } = await db.query(
        "SELECT id FROM trackability.production_outputs WHERE production_id=$1 FOR UPDATE",
        [id],
      );
      if (!rows.length) return;
      const dependent = await db.query(
        "SELECT 1 FROM trackability.production_inputs WHERE source_production_output_id=$1 LIMIT 1",
        [rows[0].id],
      );
      if (dependent.rowCount)
        throw new HttpError(409, "Output is referenced by another production");
      await db.query(
        "DELETE FROM trackability.production_outputs WHERE id=$1",
        [rows[0].id],
      );
    });
    res.status(204).end();
  }),
);

// POST /:id/complete - atomically close, calculate warnings, but NEVER block excess usage.
router.post(
  "/:id/complete",
  writeRoles,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const result = await transaction(async (db) => {
      await lockedDraft(db, id);
      const output = await db.query(
        "SELECT id FROM trackability.production_outputs WHERE production_id=$1",
        [id],
      );
      if (!output.rowCount)
        throw new HttpError(
          409,
          "Add the output lot before completing production",
        );
      const inputs = await db.query(
        `SELECT receipt_id, source_production_output_id, used_boxes FROM trackability.production_inputs WHERE production_id=$1`,
        [id],
      );
      if (!inputs.rowCount)
        throw new HttpError(
          409,
          "Add at least one input lot before completing production",
        );
      // Validate upstream productions didn't become unavailable while draft was open.
      for (const input of inputs.rows) await resolveSource(db, input, id);
      const { rows: balances } = await db.query(
        `SELECT * FROM (${inventorySQL}) stock`,
      );
      const warnings: {
        source_type: string;
        source_id: number;
        lot_number: string;
        excess_boxes: number;
      }[] = [];
      for (const input of inputs.rows) {
        const source_type =
          input.receipt_id !== null ? "receipt" : "production_output";
        const source_id = input.receipt_id ?? input.source_production_output_id;
        const balance = balances.find(
          (b: any) =>
            b.source_type === source_type && b.source_id === source_id,
        );
        if (!balance)
          throw new HttpError(
            409,
            `Input source ${source_type}:${source_id} is unavailable`,
          );
        const available = Number(balance.available_boxes);
        if (input.used_boxes > available)
          warnings.push({
            source_type,
            source_id,
            lot_number: balance.lot_number,
            excess_boxes: input.used_boxes - available,
          });
      }
      await db.query(
        `UPDATE trackability.productions SET status='completed', completed_at=NOW() WHERE id=$1`,
        [id],
      );
      return { production: await readProduction(db, id), warnings };
    });
    res.json(result);
  }),
);

// Reopen to correct quantities. Completed usage will no longer count until re-completed.
router.post(
  "/:id/reopen",
  writeRoles,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const result = await transaction(async (db) => {
      const { rows } = await db.query(
        "SELECT * FROM trackability.productions WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!rows.length) throw new HttpError(404, "Production not found");
      if (rows[0].status !== "completed")
        throw new HttpError(409, "Only completed productions can be reopened");
      const dependency = await db.query(
        `
      SELECT 1 FROM trackability.production_outputs o
      JOIN trackability.production_inputs pi ON pi.source_production_output_id = o.id
      JOIN trackability.productions downstream ON downstream.id = pi.production_id
      WHERE o.production_id=$1 AND downstream.status='completed' LIMIT 1
    `,
        [id],
      );
      if (dependency.rowCount)
        throw new HttpError(
          409,
          "Cannot reopen: a completed downstream production consumes this output",
        );
      await db.query(
        "UPDATE trackability.productions SET status='in_progress', completed_at=NULL WHERE id=$1",
        [id],
      );
      return readProduction(db, id);
    });
    res.json(result);
  }),
);

// Cancel drafts only. Preserve rows for audit; no stock consumption.
router.post(
  "/:id/cancel",
  writeRoles,
  route(async (req, res) => {
    const id = idParam(req.params.id);
    const result = await transaction(async (db) => {
      await lockedDraft(db, id);
      const dependency = await db.query(
        `
      SELECT 1 FROM trackability.production_outputs o
      JOIN trackability.production_inputs pi ON pi.source_production_output_id=o.id
      WHERE o.production_id=$1 LIMIT 1
    `,
        [id],
      );
      if (dependency.rowCount)
        throw new HttpError(
          409,
          "Cannot cancel: another production references this output",
        );
      await db.query(
        "UPDATE trackability.productions SET status='cancelled', completed_at=NULL WHERE id=$1",
        [id],
      );
      return readProduction(db, id);
    });
    res.json(result);
  }),
);

// Trace one output lot one level backward. Repeat recursively via source_production_output_id
// for finished-to-finished chains (the original receipts link further to harvesting).
router.get(
  "/trace/:lot",
  readRoles,
  route(async (req, res) => {
    const lot = req.params.lot;
    const { rows } = await pool.query(
      `
    SELECT o.output_lot_number, p.id AS production_id, p.production_date,
           p.status, pi.used_boxes, pi.receipt_id, pi.source_production_output_id,
           r.harvest_lot_number AS input_harvest_lot_number,
           prior.output_lot_number AS input_production_lot_number
    FROM trackability.production_outputs o
    JOIN trackability.productions p ON p.id=o.production_id
    LEFT JOIN trackability.production_inputs pi ON pi.production_id=p.id
    LEFT JOIN trackability.harvest_receipts r ON r.id=pi.receipt_id
    LEFT JOIN trackability.production_outputs prior ON prior.id=pi.source_production_output_id
    WHERE o.output_lot_number=$1 ORDER BY pi.id
  `,
      [lot],
    );
    if (!rows.length) throw new HttpError(404, "Output lot not found");
    res.json(rows);
  }),
);

// GET /trace/:lot/origins - all original harvest lots, across any number of production stages.
// Shows lineage, NOT exact attributable boxes after lots have been mixed.
router.get(
  "/trace/:lot/origins",
  readRoles,
  route(async (req, res) => {
    const lot = req.params.lot;
    const exists = await pool.query(
      "SELECT id FROM trackability.production_outputs WHERE output_lot_number=$1",
      [lot],
    );
    if (!exists.rowCount) throw new HttpError(404, "Output lot not found");
    const { rows } = await pool.query(
      `
    WITH RECURSIVE upstream(output_id, depth, path) AS (
      SELECT o.id, 0, ARRAY[o.id]
      FROM trackability.production_outputs o
      WHERE o.output_lot_number=$1
      UNION ALL
      SELECT preceding.id, u.depth + 1, u.path || preceding.id
      FROM upstream u
      JOIN trackability.production_outputs current_output ON current_output.id=u.output_id
      JOIN trackability.production_inputs pi ON pi.production_id=current_output.production_id
      JOIN trackability.production_outputs preceding ON preceding.id=pi.source_production_output_id
      WHERE NOT preceding.id = ANY(u.path)
    )
    SELECT DISTINCT r.harvest_lot_number
    FROM upstream u
    JOIN trackability.production_outputs o ON o.id=u.output_id
    JOIN trackability.production_inputs pi ON pi.production_id=o.production_id
    JOIN trackability.harvest_receipts r ON r.id=pi.receipt_id
    ORDER BY r.harvest_lot_number
  `,
      [lot],
    );
    res.json({ output_lot_number: lot, original_harvest_lots: rows });
  }),
);

export default router;
