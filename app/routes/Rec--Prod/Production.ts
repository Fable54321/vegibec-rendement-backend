import {
  Router,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user"]);
const overrideRoles = requireAppRole("main", ["admin"]);
const MAX_INT = 2147483647;
class HttpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}
function bigId(value: unknown): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  )
    throw new HttpError(400, "Invalid ID");
  const s = String(value);
  if (!/^[1-9]\d{0,18}$/.test(s) || BigInt(s) > 9223372036854775807n)
    throw new HttpError(400, "Invalid ID");
  return s;
}
function intId(value: unknown): number {
  const n = Number(bigId(value));
  if (n > MAX_INT) throw new HttpError(400, "Invalid ID");
  return n;
}
function quantity(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_INT
  )
    throw new HttpError(400, `${field} must be a nonnegative integer`);
  return value;
}
function getDate(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))
    throw new HttpError(400, "production_date must be YYYY-MM-DD");
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.valueOf()) || d.toISOString().slice(0, 10) !== v)
    throw new HttpError(400, "Invalid production_date");
  return v;
}
function description(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || v.length > 255)
    throw new HttpError(400, "Invalid description");
  return v;
}
function lotNumber(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 50)
    throw new HttpError(400, "Invalid lot number");
  return v.trim();
}
// Preserve the existing ISO week-year convention: YYWWDPPPP.
function validateOutputLot(v: unknown, date: string): string {
  const lot = lotNumber(v);
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 4 - day);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(
    ((thursday.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7,
  );
  const prefix = `${String(year).slice(-2)}${String(week).padStart(2, "0")}${day}`;
  if (!/^\d{9}$/.test(lot) || !lot.startsWith(prefix))
    throw new HttpError(
      400,
      `Output lot must be YYWWDPPPP and start with ${prefix}`,
    );
  return lot;
}
function userId(req: Request): number {
  const value = (req as Request & { user?: { id?: unknown } }).user?.id;
  try {
    return intId(value);
  } catch {
    throw new HttpError(401, "Authenticated user required");
  }
}
function overrideOptions(req: Request) {
  const flag = req.body?.allow_negative;
  const raw = req.body?.notes;
  if (flag !== undefined && typeof flag !== "boolean")
    throw new HttpError(400, "allow_negative must be boolean");
  if (raw != null && (typeof raw !== "string" || raw.length > 2000))
    throw new HttpError(400, "Invalid notes (maximum 2000 characters)");
  const notes = typeof raw === "string" ? raw.trim() || null : null;
  if (flag === true && !notes)
    throw new HttpError(400, "Notes are required for an availability override");
  return { allowNegative: flag === true, notes };
}
const authorizeOverride: RequestHandler = (req, res, next) => {
  if (req.body?.allow_negative === true) return overrideRoles(req, res, next);
  next();
};
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
      console.error("Production rollback failed", rollbackError);
    }
    throw error;
  } finally {
    db.release(discard);
  }
}
function respondError(res: Response, error: unknown) {
  if (error instanceof HttpError)
    return res.status(error.code).json({ error: error.message });
  const pg = error as {
    code?: string;
    message?: string;
    constraint?: string;
  } | null;
  if (pg?.code === "P0001")
    return res
      .status(409)
      .json({ error: pg.message ?? "Production operation rejected" });
  if (["23505", "40001", "40P01"].includes(pg?.code ?? ""))
    return res
      .status(409)
      .json({
        error: "Conflicting production operation",
        constraint: pg?.constraint,
      });
  if (
    ["23503", "23514", "23502", "22003", "22001", "22P02"].includes(
      pg?.code ?? "",
    )
  )
    return res
      .status(400)
      .json({
        error: "Invalid production values or reference",
        constraint: pg?.constraint,
      });
  console.error("Production API error", error);
  return res.status(500).json({ error: "Internal server error" });
}
function route(
  fn: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res) => {
    void fn(req, res).catch((error) => respondError(res, error));
  };
}
async function lockProduction(db: PoolClient, id: number, draft = true) {
  const { rows } = await db.query(
    `SELECT *, production_date::text AS production_date FROM trackability.productions WHERE id=$1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, "Production not found");
  if (draft && rows[0].status !== "in_progress")
    throw new HttpError(409, "Production must be in_progress to edit");
  return rows[0];
}

// Common lot/product projection. Original product IDs are strings when BIGINT.
const productFields = `
  l.product_id AS product_reference_id,
  pr.raw_product_id::text AS raw_product_id,
  pr.finished_product_id,
  CASE WHEN pr.raw_product_id IS NOT NULL THEN 'raw_product' ELSE 'finished_product' END AS product_source,
  COALESCE(pr.raw_product_id, pr.finished_product_id)::text AS source_product_id,
  COALESCE(rp.product_code::text, fp.product_code::text) AS product_code,
  COALESCE(rp.description::text, fp.full_name::text) AS product_name`;
const productJoins = `
  LEFT JOIN trackability.product_reference pr ON pr.id=l.product_id
  LEFT JOIN public.raw_product rp ON rp.id=pr.raw_product_id
  LEFT JOIN public.finished_product fp ON fp.id=pr.finished_product_id`;
const inputSelect = `
  SELECT pi.id, pi.production_id, pi.lot_id::text AS lot_id, pi.used_boxes, pi.created_at,
    l.lot_number, l.lot_type,
    CASE WHEN l.lot_type='harvest' THEN l.lot_number END AS input_harvest_lot_number,
    CASE WHEN l.lot_type='production' THEN l.lot_number END AS input_production_lot_number,
    ${productFields},
    lb.total_boxes::text AS total_boxes, lb.reserved_boxes::text AS reserved_boxes,
    lb.used_boxes::text AS lot_used_boxes, lb.available_boxes::text AS available_boxes,
    (lb.available_boxes + CASE WHEN prod.status='in_progress' THEN pi.used_boxes ELSE 0 END)::text AS available_for_this_input,
    (pi.used_boxes=0) AS is_zero_quantity
  FROM trackability.production_inputs pi
  JOIN trackability.productions prod ON prod.id=pi.production_id
  JOIN trackability.lots l ON l.id=pi.lot_id
  ${productJoins}
  JOIN trackability.lot_balances lb ON lb.lot_id=l.id`;
const outputSelect = `
  SELECT o.id, o.production_id, o.lot_id::text AS lot_id, o.produced_boxes, o.number_of_pallets, o.created_at,
    l.lot_number AS output_lot_number, l.lot_number, ${productFields}
  FROM trackability.production_outputs o JOIN trackability.lots l ON l.id=o.lot_id
  ${productJoins}`;
async function readProduction(db: Pick<PoolClient, "query">, id: number) {
  // Single statement: all returned details share one snapshot.
  const { rows } = await db.query(
    `
    SELECT p.*, p.production_date::text AS production_date,
      COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM (${inputSelect} WHERE pi.production_id=p.id) i), '[]'::jsonb) AS inputs,
      (SELECT to_jsonb(o) FROM (${outputSelect} WHERE o.production_id=p.id) o) AS output
    FROM trackability.productions p WHERE p.id=$1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, "Production not found");
  return rows[0];
}
async function setInput(
  db: PoolClient,
  id: number,
  boxes: number,
  actor: number,
  allowNegative: boolean,
  notes: string | null,
) {
  await db.query(
    `SELECT trackability.set_production_input_quantity($1::bigint,$2::integer,$3::integer,$4::boolean,$5::text)`,
    [id, boxes, actor, allowNegative, notes],
  );
}
async function warnings(db: PoolClient, id: number) {
  const { rows } = await db.query(
    `SELECT DISTINCT lb.lot_id::text AS lot_id, lb.lot_number,
    (-lb.available_boxes)::text AS excess_boxes
    FROM trackability.production_inputs pi JOIN trackability.lot_balances lb ON lb.lot_id=pi.lot_id
    WHERE pi.production_id=$1 AND pi.used_boxes>0 AND lb.available_boxes<0 ORDER BY lot_number`,
    [id],
  );
  return rows;
}

// One result per lot, not per reception or production output. Include exhausted
// posted lots for visibility; availableOnly=true restricts to free stock.
router.get(
  "/available-inputs",
  readRoles,
  route(async (req, res) => {
    const q = req.query.q ?? "";
    if (typeof q !== "string" || q.length > 100)
      throw new HttpError(400, "Invalid search query");
    const only = req.query.availableOnly;
    if (only !== undefined && only !== "true" && only !== "false")
      throw new HttpError(400, "Invalid availableOnly");
    const { rows } = await pool.query(
      `
    SELECT l.id::text AS lot_id, l.lot_number, l.lot_type, ${productFields},
      lb.total_boxes AS incoming_boxes, lb.used_boxes AS consumed_boxes,
      lb.reserved_boxes AS open_boxes, lb.reserved_boxes, lb.used_boxes, lb.total_boxes,
      (lb.total_boxes-lb.used_boxes) AS remaining_boxes,
      lb.available_boxes, lb.available_boxes AS projected_boxes
    FROM trackability.lot_balances lb JOIN trackability.lots l ON l.id=lb.lot_id
    ${productJoins}
    WHERE EXISTS (SELECT 1 FROM trackability.lot_movements m WHERE m.lot_id=l.id AND m.total_delta>0)
      AND ($1::text='' OR l.lot_number ILIKE '%'||$1||'%' OR COALESCE(rp.product_code::text,fp.product_code::text) ILIKE '%'||$1||'%' OR COALESCE(rp.description::text,fp.full_name::text) ILIKE '%'||$1||'%')
      AND (NOT $2::boolean OR lb.available_boxes>0)
    ORDER BY l.lot_date DESC,l.id DESC LIMIT 500`,
      [q.trim(), only === "true"],
    );
    return res.json(rows);
  }),
);
router.get(
  "/",
  readRoles,
  route(async (req, res) => {
    const status = req.query.status ?? null;
    if (
      status !== null &&
      (typeof status !== "string" ||
        !["in_progress", "completed", "cancelled"].includes(status))
    )
      throw new HttpError(400, "Invalid status");
    const { rows } = await pool.query(
      `SELECT p.*,p.production_date::text AS production_date,
    o.id AS output_id,o.lot_id::text AS output_lot_id,l.lot_number AS output_lot_number,
    CASE WHEN o.id IS NULL THEN NULL ELSE l.product_id END AS product_reference_id,
    pr.raw_product_id::text AS raw_product_id,pr.finished_product_id,
    CASE WHEN pr.raw_product_id IS NOT NULL THEN 'raw_product' WHEN pr.finished_product_id IS NOT NULL THEN 'finished_product' END AS product_source,
    COALESCE(pr.raw_product_id,pr.finished_product_id)::text AS source_product_id,o.produced_boxes,o.number_of_pallets
    FROM trackability.productions p LEFT JOIN trackability.production_outputs o ON o.production_id=p.id
    LEFT JOIN trackability.lots l ON l.id=o.lot_id LEFT JOIN trackability.product_reference pr ON pr.id=l.product_id
    WHERE ($1::text IS NULL OR p.status=$1) ORDER BY p.production_date DESC,p.id DESC LIMIT 200`,
      [status],
    );
    return res.json(rows);
  }),
);
router.get(
  "/:id",
  readRoles,
  route(async (req, res) =>
    res.json(await readProduction(pool, intId(req.params.id))),
  ),
);
router.post(
  "/",
  writeRoles,
  route(async (req, res) => {
    const date = getDate(req.body?.production_date),
      desc = description(req.body?.description ?? null);
    const result = await transaction(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO trackability.productions(description,production_date) VALUES($1,$2) RETURNING *,production_date::text AS production_date`,
        [desc, date],
      );
      return rows[0];
    });
    return res.status(201).json(result);
  }),
);
router.patch(
  "/:id",
  writeRoles,
  route(async (req, res) => {
    const id = intId(req.params.id);
    const result = await transaction(async (db) => {
      const p = await lockProduction(db, id);
      const date =
        req.body?.production_date === undefined
          ? p.production_date
          : getDate(req.body.production_date);
      const desc =
        req.body?.description === undefined
          ? p.description
          : description(req.body.description);
      if (date !== p.production_date) {
        const o = await db.query(
          "SELECT 1 FROM trackability.production_outputs WHERE production_id=$1",
          [id],
        );
        if (o.rows.length)
          throw new HttpError(
            409,
            "Remove the output before changing production_date",
          );
      }
      const { rows } = await db.query(
        `UPDATE trackability.productions SET description=$2,production_date=$3 WHERE id=$1 RETURNING *,production_date::text AS production_date`,
        [id, desc, date],
      );
      return rows[0];
    });
    return res.json(result);
  }),
);

// Replace the desired input list without replacing historical input IDs.
// Omitted inputs are released to zero; historical rows are retained.
router.put(
  "/:id/inputs",
  writeRoles,
  authorizeOverride,
  route(async (req, res) => {
    const id = intId(req.params.id),
      actor = userId(req),
      options = overrideOptions(req);
    const raw: unknown = req.body?.inputs;
    if (!Array.isArray(raw) || raw.length > 200)
      throw new HttpError(400, "inputs must be an array of at most 200 items");
    const desired = new Map<string, number>();
    for (const value of raw) {
      if (!value || typeof value !== "object")
        throw new HttpError(400, "Invalid input");
      const lot = bigId(value.lot_id),
        boxes = quantity(value.used_boxes, "used_boxes");
      if (desired.has(lot))
        throw new HttpError(400, "Duplicate lot_id in request");
      desired.set(lot, boxes);
    }
    const result = await transaction(async (db) => {
      await lockProduction(db, id);
      const { rows: existing } = await db.query(
        `SELECT id,lot_id::text AS lot_id,used_boxes FROM trackability.production_inputs WHERE production_id=$1 ORDER BY lot_id,id FOR UPDATE`,
        [id],
      );
      const byLot = new Map<
        string,
        { id: number; lot_id: string; used_boxes: number }
      >();
      for (const row of existing) {
        if (byLot.has(row.lot_id))
          throw new HttpError(
            409,
            "Duplicate existing inputs for one lot; resolve before editing",
          );
        byLot.set(row.lot_id, row);
      }
      // Release decreases first, including inputs omitted from the payload.
      for (const row of existing) {
        const target = desired.get(row.lot_id) ?? 0;
        if (target < row.used_boxes)
          await setInput(db, row.id, target, actor, false, options.notes);
        if (!desired.has(row.lot_id))
          await db.query(
            `DELETE FROM trackability.production_inputs pi WHERE pi.id=$1 AND pi.used_boxes=0 AND NOT EXISTS(SELECT 1 FROM trackability.lot_movements m WHERE m.production_input_id=pi.id)`,
            [row.id],
          );
      }
      for (const [lot, boxes] of desired) {
        const old = byLot.get(lot);
        if (old) {
          if (boxes > old.used_boxes)
            await setInput(
              db,
              old.id,
              boxes,
              actor,
              options.allowNegative,
              options.notes,
            );
          continue;
        }
        const source = await db.query(
          `SELECT l.id FROM trackability.lots l WHERE l.id=$1 AND EXISTS(SELECT 1 FROM trackability.lot_movements m WHERE m.lot_id=l.id AND m.total_delta>0)`,
          [lot],
        );
        if (!source.rows.length)
          throw new HttpError(409, "Input lot has no posted inventory");
        const { rows } = await db.query(
          `INSERT INTO trackability.production_inputs(production_id,lot_id,used_boxes) VALUES($1,$2,0) RETURNING id`,
          [id, lot],
        );
        await setInput(
          db,
          rows[0].id,
          boxes,
          actor,
          options.allowNegative,
          options.notes,
        );
      }
      return {
        ...(await readProduction(db, id)),
        warnings: await warnings(db, id),
      };
    });
    return res.json(result);
  }),
);

// Resolve output product, accepting the old typed IDs or the new central ID.
async function resolveProduct(db: PoolClient, body: any): Promise<number> {
  const raw = body?.raw_product_id ?? null,
    finished = body?.finished_product_id ?? null;
  const ref = body?.product_reference_id ?? null;
  if (raw !== null && finished !== null)
    throw new HttpError(400, "Choose exactly one product type");
  if (ref === null && raw === null && finished === null)
    throw new HttpError(400, "Product reference is required");
  const { rows } = await db.query(
    `SELECT id FROM trackability.product_reference WHERE
    ($1::integer IS NULL OR id=$1) AND ($2::bigint IS NULL OR raw_product_id=$2) AND ($3::integer IS NULL OR finished_product_id=$3)`,
    [
      ref === null ? null : intId(ref),
      raw === null ? null : bigId(raw),
      finished === null ? null : intId(finished),
    ],
  );
  if (rows.length !== 1)
    throw new HttpError(400, "Invalid or inconsistent product reference");
  return rows[0].id;
}
router.put(
  "/:id/output",
  writeRoles,
  route(async (req, res) => {
    const id = intId(req.params.id),
      boxes = quantity(req.body?.produced_boxes, "produced_boxes"),
      pallets = quantity(req.body?.number_of_pallets, "number_of_pallets");
    const result = await transaction(async (db) => {
      const p = await lockProduction(db, id);
      const product = await resolveProduct(db, req.body);
      const number = validateOutputLot(
        req.body?.output_lot_number,
        p.production_date,
      );
      await db.query(
        `INSERT INTO trackability.lots(lot_number,lot_type,product_id,lot_date) VALUES($1,'production',$2,$3) ON CONFLICT(lot_number) DO NOTHING`,
        [number, product, p.production_date],
      );
      const { rows } = await db.query(
        `SELECT id::text AS id,lot_type,product_id,lot_date::text AS lot_date FROM trackability.lots WHERE lot_number=$1 FOR UPDATE`,
        [number],
      );
      const lot = rows[0];
      if (
        !lot ||
        lot.lot_type !== "production" ||
        lot.product_id !== product ||
        lot.lot_date !== p.production_date
      )
        throw new HttpError(
          409,
          "Output lot number belongs to a different product, date or lot type",
        );
      await db.query(
        `INSERT INTO trackability.production_outputs(production_id,lot_id,produced_boxes,number_of_pallets) VALUES($1,$2,$3,$4)
      ON CONFLICT(production_id) DO UPDATE SET lot_id=EXCLUDED.lot_id,produced_boxes=EXCLUDED.produced_boxes,number_of_pallets=EXCLUDED.number_of_pallets`,
        [id, lot.id, boxes, pallets],
      );
      const output = await db.query(
        `${outputSelect} WHERE o.production_id=$1`,
        [id],
      );
      return output.rows[0];
    });
    return res.json(result);
  }),
);
router.delete(
  "/:id/output",
  writeRoles,
  route(async (req, res) => {
    const id = intId(req.params.id);
    await transaction(async (db) => {
      await lockProduction(db, id);
      await db.query(
        "DELETE FROM trackability.production_outputs WHERE production_id=$1",
        [id],
      );
      // Preserve central lot: other productions can share it.
    });
    return res.status(204).end();
  }),
);
router.post(
  "/:id/complete",
  writeRoles,
  authorizeOverride,
  route(async (req, res) => {
    const id = intId(req.params.id),
      actor = userId(req),
      options = overrideOptions(req);
    const result = await transaction(async (db) => {
      const p = await lockProduction(db, id, false);
      if (p.status === "cancelled")
        throw new HttpError(409, "Cancelled production cannot be completed");
      await db.query(
        `SELECT trackability.finalize_production($1::bigint,$2::integer,$3::boolean,$4::text)`,
        [id, actor, options.allowNegative, options.notes],
      );
      return {
        production: await readProduction(db, id),
        warnings: await warnings(db, id),
      };
    });
    return res.json(result);
  }),
);
// Keep old URL, but never reopen an immutable posting.
router.post(
  "/:id/reopen",
  writeRoles,
  route(async (req, res) => {
    const id = intId(req.params.id);
    const { rows } = await pool.query(
      "SELECT id FROM trackability.productions WHERE id=$1",
      [id],
    );
    if (!rows.length) throw new HttpError(404, "Production not found");
    throw new HttpError(
      409,
      "Posted productions cannot be reopened; inventory corrections require a separate audited operation",
    );
  }),
);
router.post(
  "/:id/cancel",
  writeRoles,
  route(async (req, res) => {
    const id = intId(req.params.id),
      actor = userId(req);
    const notes = req.body?.notes ?? null;
    if (notes !== null && (typeof notes !== "string" || notes.length > 2000))
      throw new HttpError(400, "Invalid notes");
    const result = await transaction(async (db) => {
      const p = await lockProduction(db, id, false);
      if (p.status === "completed")
        throw new HttpError(409, "Completed production cannot be cancelled");
      await db.query(
        `SELECT trackability.cancel_production($1::bigint,$2::integer,$3::text)`,
        [id, actor, notes],
      );
      return readProduction(db, id);
    });
    return res.json(result);
  }),
);

// Posted genealogy, not provisional draft relationships.
router.get(
  "/trace/:lot/origins",
  readRoles,
  route(async (req, res) => {
    const number = lotNumber(req.params.lot);
    const { rows } = await pool.query(
      `SELECT l.lot_number AS output_lot_number,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('harvest_lot_number',h.lot_number,'lot_id',h.id::text) ORDER BY h.lot_number) FROM trackability.get_lot_harvest_origins(l.id) h),'[]'::jsonb) AS original_harvest_lots
    FROM trackability.lots l WHERE l.lot_number=$1 AND l.lot_type='production'`,
      [number],
    );
    if (!rows.length) throw new HttpError(404, "Output lot not found");
    return res.json(rows[0]);
  }),
);
router.get(
  "/trace/:lot",
  readRoles,
  route(async (req, res) => {
    const number = lotNumber(req.params.lot);
    const { rows } = await pool.query(
      `SELECT child.lot_number AS output_lot_number,child.id::text AS output_lot_id,
    p.id AS production_id,p.production_date,p.status,pi.used_boxes,pi.id AS production_input_id,
    parent.id::text AS lot_id,parent.lot_number,parent.lot_type,
    CASE WHEN parent.lot_type='harvest' THEN parent.lot_number END AS input_harvest_lot_number,
    CASE WHEN parent.lot_type='production' THEN parent.lot_number END AS input_production_lot_number
    FROM trackability.lots child JOIN trackability.lot_genealogy g ON g.child_lot_id=child.id
    JOIN trackability.productions p ON p.id=g.production_id
    JOIN trackability.lots parent ON parent.id=g.parent_lot_id
    JOIN trackability.production_inputs pi ON pi.production_id=p.id AND pi.lot_id=parent.id AND pi.used_boxes>0
    WHERE child.lot_number=$1 AND child.lot_type='production' ORDER BY p.id,pi.id`,
      [number],
    );
    if (!rows.length) {
      const exists = await pool.query(
        "SELECT 1 FROM trackability.lots WHERE lot_number=$1 AND lot_type='production'",
        [number],
      );
      if (!exists.rows.length) throw new HttpError(404, "Output lot not found");
    }
    return res.json(rows);
  }),
);
export default router;
