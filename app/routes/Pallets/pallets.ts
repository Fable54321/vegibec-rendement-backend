import { Router, type Request, type Response } from "express";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();
const readRoles = requireAppRole("main", ["admin", "user", "guest"]);
const writeRoles = requireAppRole("main", ["admin", "user"]);
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function id(v: unknown): string {
  if (
    (typeof v !== "string" && typeof v !== "number") ||
    (typeof v === "number" && !Number.isSafeInteger(v))
  )
    throw new HttpError(400, "Invalid ID");
  const s = String(v);
  if (!/^[1-9]\d{0,18}$/.test(s) || BigInt(s) > 9223372036854775807n)
    throw new HttpError(400, "Invalid ID");
  return s;
}
function userId(req: Request): number {
  const v = (req as Request & { user?: { id?: unknown } }).user?.id;
  if (v == null) throw new HttpError(401, "Authentication required");
  const n = Number(id(v));
  if (n > 2147483647) throw new HttpError(400, "Invalid user ID");
  return n;
}
function quantity(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 2147483647)
    throw new HttpError(400, "amount_of_boxes must be a nonnegative integer");
  return v;
}
function route(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((e: unknown) => {
      if (e instanceof HttpError)
        return res.status(e.status).json({ error: e.message });
      const pg = e as { code?: string; message?: string };
      if (pg.code === "P0001")
        return res.status(409).json({ error: pg.message });
      if (["23503", "23505", "23514", "40001", "40P01"].includes(pg.code ?? ""))
        return res
          .status(409)
          .json({
            error:
              "Database constraint or concurrent operation; review and retry",
          });
      console.error("Pallet API", e);
      return res.status(500).json({ error: "Pallet operation failed" });
    });
  };
}
async function tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await db.query("SELECT pg_advisory_xact_lock(7142,1)");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await db.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw e;
  } finally {
    db.release(discard);
  }
}
type Queryable = Pick<PoolClient, "query">;
const palletHeader = `SELECT p.*, p.id::text AS id,p.order_id::text AS order_id,o.order_reference,o.client_name
 FROM trackability.pallets p JOIN sales.orders o ON o.id=p.order_id`;
async function lockPallet(db: PoolClient, palletId: string) {
  const { rows } = await db.query(
    "SELECT *,id::text AS id,order_id::text AS order_id FROM trackability.pallets WHERE id=$1 FOR UPDATE",
    [palletId],
  );
  if (!rows.length) throw new HttpError(404, "Pallet not found");
  return rows[0];
}
async function lockOrder(db: PoolClient, orderId: string) {
  const { rows } = await db.query(
    "SELECT id,status FROM sales.orders WHERE id=$1 FOR UPDATE",
    [orderId],
  );
  if (!rows.length) throw new HttpError(404, "Order not found");
  return rows[0];
}
const itemSQL = `SELECT pi.id::text AS id,pi.lot_id::text AS lot_id,l.lot_number,pi.amount_of_boxes,
 pr.finished_product_id,fp.product_code::text AS product_code,fp.full_name AS product_name,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',pa.id::text,'sale_allocation_id',a.id::text,'order_item_id',a.order_item_id::text,'amount_of_boxes',pa.amount_of_boxes) ORDER BY pa.id)
 FROM sales.pallet_allocations pa JOIN sales.order_item_lot_allocations a ON a.id=pa.sale_allocation_id WHERE pa.pallet_item_id=pi.id),'[]'::jsonb) AS allocations
 FROM trackability.pallet_items pi JOIN trackability.lots l ON l.id=pi.lot_id
 JOIN trackability.product_reference pr ON pr.id=l.product_id LEFT JOIN public.finished_product fp ON fp.id=pr.finished_product_id`;
async function readPallet(db: Queryable, palletId: string) {
  const { rows } = await db.query(`${palletHeader} WHERE p.id=$1`, [palletId]);
  if (!rows.length) throw new HttpError(404, "Pallet not found");
  const items = (
    await db.query(`${itemSQL} WHERE pi.pallet_id=$1 ORDER BY pi.id`, [
      palletId,
    ])
  ).rows;
  const total = items.reduce((sum, x) => sum + Number(x.amount_of_boxes), 0);
  const products = new Set(items.map((x) => x.finished_product_id));
  const warnings: { code: string; message: string }[] = [];
  if (products.size > 1)
    warnings.push({
      code: "mixed_products",
      message: "Cette palette contient plusieurs produits de la même commande.",
    });
  if (products.size === 1) {
    const { rows: standards } = await db.query(
      `SELECT DISTINCT quantity_per_pallet FROM sales.order_items WHERE order_id=$1 AND finished_product_id=$2 AND quantity_per_pallet>0`,
      [rows[0].order_id, items[0].finished_product_id],
    );
    if (
      standards.length === 1 &&
      total > Number(standards[0].quantity_per_pallet)
    )
      warnings.push({
        code: "above_standard_capacity",
        message: "La quantité dépasse la quantité habituelle par palette.",
      });
  }
  return {
    ...rows[0],
    items,
    total_boxes: total,
    distinct_products: products.size,
    warnings,
  };
}
// Counts quantities once: shipped is already a subset of allocated stock.
const prepSQL = `SELECT oi.id::text AS order_item_id,oi.finished_product_id,oi.product_code,oi.product_name,oi.quantity_ordered,oi.quantity_per_pallet,
 COALESCE(b.reserved,0)::text AS reserved_boxes,COALESCE(b.shipped,0)::text AS shipped_boxes,
 COALESCE(b.prepared,0)::text AS prepared_unshipped_boxes,
 COALESCE(b.free,0)::text AS reserved_not_prepared_boxes,
 (oi.quantity_ordered-COALESCE(b.reserved,0)-COALESCE(b.shipped,0))::text AS unallocated_boxes,
 (oi.quantity_ordered-COALESCE(b.prepared,0)-COALESCE(b.shipped,0))::text AS remaining_to_prepare
 FROM sales.order_items oi LEFT JOIN LATERAL (
 SELECT SUM(reserved_boxes) reserved,SUM(shipped_boxes) shipped,SUM(assigned_unshipped_boxes) prepared,SUM(remaining_to_assign) free
 FROM sales.lot_allocation_preparation WHERE order_item_id=oi.id) b ON TRUE WHERE oi.order_id=$1`;
router.get(
  "/orders/:orderId/preparation",
  readRoles,
  route(async (req, res) => {
    const orderId = id(req.params.orderId);
    const { rows } = await pool.query(
      "SELECT * FROM sales.orders WHERE id=$1",
      [orderId],
    );
    if (!rows.length) throw new HttpError(404, "Order not found");
    const items = (await pool.query(`${prepSQL} ORDER BY oi.id`, [orderId]))
      .rows;
    const pallets = (
      await pool.query(`${palletHeader} WHERE p.order_id=$1 ORDER BY p.id`, [
        orderId,
      ])
    ).rows;
    return res.json({ order: rows[0], items, pallets });
  }),
);
router.get(
  "/orders/:orderId/lots/:lotNumber",
  readRoles,
  route(async (req, res) => {
    const orderId = id(req.params.orderId);
    const lotNumber = String(req.params.lotNumber).trim();
    if (!lotNumber || lotNumber.length > 50)
      throw new HttpError(400, "Invalid lot number");
    const { rows } = await pool.query(
      `SELECT lb.lot_id::text AS lot_id,lb.lot_number,lb.finished_product_id,fp.product_code,fp.full_name AS product_name,lb.available_boxes,
 EXISTS(SELECT 1 FROM sales.order_items oi WHERE oi.order_id=$1 AND oi.finished_product_id=lb.finished_product_id) AS belongs_to_order,
 COALESCE((SELECT SUM(remaining_to_assign) FROM sales.lot_allocation_preparation WHERE order_id=$1 AND lot_id=lb.lot_id),0)::text AS reserved_not_prepared_boxes
 FROM trackability.lot_balances lb LEFT JOIN public.finished_product fp ON fp.id=lb.finished_product_id WHERE lb.lot_number=$2`,
      [orderId, lotNumber],
    );
    if (!rows.length) throw new HttpError(404, "Lot not found");
    if (!rows[0].belongs_to_order)
      throw new HttpError(409, "Ce produit ne fait pas partie de la commande.");
    return res.json(rows[0]);
  }),
);
router.get(
  "/",
  readRoles,
  route(async (req, res) => {
    const orderId =
      req.query.orderId === undefined ? null : id(req.query.orderId);
    const status = req.query.status ?? null;
    if (
      status !== null &&
      (typeof status !== "string" ||
        !["draft", "finalized", "shipped", "cancelled"].includes(status))
    )
      throw new HttpError(400, "Invalid status");
    const { rows } = await pool.query(
      `${palletHeader} WHERE ($1::bigint IS NULL OR p.order_id=$1) AND ($2::text IS NULL OR p.status=$2) ORDER BY p.id DESC LIMIT 250`,
      [orderId, status],
    );
    return res.json(rows);
  }),
);
router.post(
  "/",
  writeRoles,
  route(async (req, res) => {
    const orderId = id(req.body?.order_id),
      actor = userId(req);
    const result = await tx(async (db) => {
      await lockOrder(db, orderId);
      // Globally unique label identifier; no extra sequence migration required.
      const number = `P-${randomUUID().replace(/-/g, "").toUpperCase()}`;
      const { rows } = await db.query(
        "INSERT INTO trackability.pallets(order_id,pallet_number,created_by_user_id,status) VALUES($1,$2,$3,'draft') RETURNING id::text AS id",
        [orderId, number, actor],
      );
      return readPallet(db, rows[0].id);
    });
    return res.status(201).json(result);
  }),
);
// Set absolute quantity, not an increment, so retries do not add boxes twice.
async function setItem(
  db: PoolClient,
  palletId: string,
  lotId: string,
  boxes: number,
  actor: number,
) {
  const pallet = await lockPallet(db, palletId);
  if (pallet.status !== "draft")
    throw new HttpError(409, "Reopen the pallet before editing");
  await lockOrder(db, pallet.order_id);
  const existing = (
    await db.query(
      "SELECT id::text AS id FROM trackability.pallet_items WHERE pallet_id=$1 AND lot_id=$2 FOR UPDATE",
      [palletId, lotId],
    )
  ).rows[0];
  // Release only physical assignments, not commercial reservations. Rollback restores them if any subsequent step fails.
  if (existing)
    await db.query(
      "DELETE FROM sales.pallet_allocations WHERE pallet_item_id=$1",
      [existing.id],
    );
  if (boxes === 0) {
    if (existing)
      await db.query("DELETE FROM trackability.pallet_items WHERE id=$1", [
        existing.id,
      ]);
    return readPallet(db, palletId);
  }
  const lot = (
    await db.query(
      "SELECT finished_product_id FROM trackability.lot_balances WHERE lot_id=$1",
      [lotId],
    )
  ).rows[0];
  if (!lot) throw new HttpError(404, "Lot not found");
  if (lot.finished_product_id == null)
    throw new HttpError(409, "Raw product is not an ordered finished product");
  const lines = (
    await db.query(`${prepSQL} AND oi.finished_product_id=$2 ORDER BY oi.id`, [
      pallet.order_id,
      lot.finished_product_id,
    ])
  ).rows;
  if (!lines.length)
    throw new HttpError(409, "Ce produit ne fait pas partie de la commande.");
  const itemId =
    existing?.id ??
    (
      await db.query(
        "INSERT INTO trackability.pallet_items(pallet_id,lot_id,amount_of_boxes) VALUES($1,$2,$3) RETURNING id::text AS id",
        [palletId, lotId, boxes],
      )
    ).rows[0].id;
  if (existing)
    await db.query(
      "UPDATE trackability.pallet_items SET amount_of_boxes=$2 WHERE id=$1",
      [itemId, boxes],
    );
  let remaining = boxes;
  // Use existing reservations for this exact lot first, across order lines of the same product.
  for (const line of lines) {
    const free = (
      await db.query(
        `SELECT allocation_id::text AS id,remaining_to_assign FROM sales.lot_allocation_preparation WHERE order_id=$1 AND order_item_id=$2 AND lot_id=$3 AND remaining_to_assign>0 ORDER BY allocation_id`,
        [pallet.order_id, line.order_item_id, lotId],
      )
    ).rows;
    let lineRoom = Math.max(0, Math.floor(Number(line.remaining_to_prepare)));
    for (const a of free) {
      const n = Math.min(remaining, lineRoom, Number(a.remaining_to_assign));
      if (n <= 0) continue;
      await db.query(
        "INSERT INTO sales.pallet_allocations(pallet_item_id,sale_allocation_id,amount_of_boxes) VALUES($1,$2,$3)",
        [itemId, a.id, n],
      );
      remaining -= n;
      lineRoom -= n;
    }
  }
  // Reserve additional boxes only against an unallocated part of the order line.
  for (const line of lines) {
    if (!remaining) break;
    const n = Math.min(
      remaining,
      Math.max(0, Math.floor(Number(line.unallocated_boxes))),
    );
    if (!n) continue;
    const a = (
      await db.query(
        "INSERT INTO sales.order_item_lot_allocations(order_id,order_item_id,lot_id,quantity) VALUES($1,$2,$3,$4) RETURNING id::text AS id",
        [pallet.order_id, line.order_item_id, lotId, n],
      )
    ).rows[0];
    await db.query(
      "SELECT sales.reserve_lot_allocation($1::bigint,$2::integer)",
      [a.id, actor],
    );
    await db.query(
      "INSERT INTO sales.pallet_allocations(pallet_item_id,sale_allocation_id,amount_of_boxes) VALUES($1,$2,$3)",
      [itemId, a.id, n],
    );
    remaining -= n;
  }
  if (remaining)
    throw new HttpError(
      409,
      "Quantité non couverte par la commande ou les réservations de ce lot. Ajustez les allocations de vente.",
    );
  return readPallet(db, palletId);
}
router.put(
  "/:id/items/:lotId",
  writeRoles,
  route(async (req, res) => {
    const p = id(req.params.id),
      l = id(req.params.lotId),
      q = quantity(req.body?.amount_of_boxes),
      u = userId(req);
    return res.json(await tx((db) => setItem(db, p, l, q, u)));
  }),
);
router.delete(
  "/:id/items/:lotId",
  writeRoles,
  route(async (req, res) => {
    const p = id(req.params.id),
      l = id(req.params.lotId),
      u = userId(req);
    return res.json(await tx((db) => setItem(db, p, l, 0, u)));
  }),
);
async function validateComposition(db: PoolClient, palletId: string) {
  const { rows } = await db.query(
    `SELECT pi.id FROM trackability.pallet_items pi JOIN trackability.pallets p ON p.id=pi.pallet_id JOIN trackability.lots l ON l.id=pi.lot_id JOIN trackability.product_reference pr ON pr.id=l.product_id
 WHERE pi.pallet_id=$1 AND (pi.amount_of_boxes <> COALESCE((SELECT SUM(pa.amount_of_boxes) FROM sales.pallet_allocations pa WHERE pa.pallet_item_id=pi.id),0)
 OR EXISTS(SELECT 1 FROM sales.pallet_allocations pa JOIN sales.order_item_lot_allocations a ON a.id=pa.sale_allocation_id JOIN sales.order_items oi ON oi.id=a.order_item_id WHERE pa.pallet_item_id=pi.id AND (a.order_id IS DISTINCT FROM p.order_id OR oi.order_id IS DISTINCT FROM p.order_id OR a.lot_id IS DISTINCT FROM pi.lot_id OR oi.finished_product_id IS DISTINCT FROM pr.finished_product_id)))`,
    [palletId],
  );
  if (rows.length)
    throw new HttpError(
      409,
      "Pallet composition and order allocations do not match",
    );
}
router.post(
  "/:id/finalize",
  writeRoles,
  route(async (req, res) => {
    const p = id(req.params.id);
    userId(req);
    return res.json(
      await tx(async (db) => {
        const pallet = await lockPallet(db, p);
        if (pallet.status === "finalized") return readPallet(db, p);
        if (pallet.status !== "draft")
          throw new HttpError(409, "Only draft pallets can be finalized");
        const detail = await readPallet(db, p);
        if (!detail.items.length)
          throw new HttpError(409, "Cannot finalize an empty pallet");
        await validateComposition(db, p);
        // Warning acknowledgement is informational, not an elevated permission.
        if (detail.warnings.length && req.body?.confirm_warnings !== true)
          throw new HttpError(
            409,
            detail.warnings
  .map((w: { code: string; message: string }) => w.message)
  .join(" ") +
              " Confirm with confirm_warnings=true.",
          );
        await db.query(
          "UPDATE trackability.pallets SET status='finalized' WHERE id=$1",
          [p],
        );
        return readPallet(db, p);
      }),
    );
  }),
);
router.post(
  "/:id/reopen",
  writeRoles,
  route(async (req, res) => {
    const p = id(req.params.id);
    userId(req);
    return res.json(
      await tx(async (db) => {
        const row = await lockPallet(db, p);
        if (row.status === "draft") return readPallet(db, p);
        if (row.status !== "finalized")
          throw new HttpError(
            409,
            "Only unshipped finalized pallets can be reopened",
          );
        await db.query(
          "UPDATE trackability.pallets SET status='draft' WHERE id=$1",
          [p],
        );
        return readPallet(db, p);
      }),
    );
  }),
);
router.post(
  "/:id/cancel",
  writeRoles,
  route(async (req, res) => {
    const p = id(req.params.id);
    userId(req);
    return res.json(
      await tx(async (db) => {
        const row = await lockPallet(db, p);
        if (row.status === "cancelled") return readPallet(db, p);
        if (row.status === "shipped")
          throw new HttpError(409, "Cannot cancel a shipped pallet");
        await db.query(
          "UPDATE trackability.pallets SET status='cancelled' WHERE id=$1",
          [p],
        );
        return readPallet(db, p);
      }),
    );
  }),
);
router.get(
  "/:id/label",
  readRoles,
  route(async (req, res) => {
    const detail = await readPallet(pool, id(req.params.id));
    if (!["finalized", "shipped"].includes(detail.status))
      throw new HttpError(409, "Pallet must be finalized before printing");
    return res.json(detail);
  }),
);
router.get(
  "/:id",
  readRoles,
  route(async (req, res) =>
    res.json(await readPallet(pool, id(req.params.id))),
  ),
);
export default router;
