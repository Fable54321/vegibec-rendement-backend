import type { Request, Response } from "express";

import { pool } from "../../../db";
import { ensureTransportScanTables } from "../transport.controller";
import { ensureTransportOnlyOrdersTable } from "../transportOnlyOrders.controller";

export async function listSavedOrders(req: Request, res: Response): Promise<void> {
  try {
    const type = req.query.type === "generated" ? "generated" : "scanned";
    await ensureTransportScanTables();
    await ensureTransportOnlyOrdersTable();

    const result = type === "generated"
      ? await pool.query(`
          SELECT o.id, o.generated_id AS source_id, o.address_id, o.loaded_date,
                 o.pallets, o.estimated_weight, o.product_matches, o.order_data,
                 o.created_at,
                 COALESCE((
                   SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name))
                   FROM logistics.transport_route_plans p
                   WHERE EXISTS (
                     SELECT 1 FROM jsonb_array_elements(p.items) item
                     WHERE item->>'id' = o.generated_id::text
                   )
                 ), '[]'::jsonb) AS prepared_plans
          FROM logistics.transport_only_orders o
          ORDER BY o.loaded_date DESC, o.created_at DESC
        `)
      : await pool.query(`
          SELECT i.id::text AS id, i.id AS source_id, i.address_id, i.loaded_date,
                 i.pallets, i.estimated_weight, i.product_matches,
                 jsonb_build_object(
                   'client_name', c.name,
                   'site_name', a.site_name,
                   'city', a.city,
                   'recognized_client_name', i.recognized_client_name,
                   'recognized_address', i.recognized_address,
                   'recognized_city', i.recognized_city,
                   'recognized_postal_code', i.recognized_postal_code
                 ) AS order_data,
                 i.created_at,
                 COALESCE((
                   SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name))
                   FROM logistics.transport_route_plans p
                   WHERE EXISTS (
                     SELECT 1 FROM jsonb_array_elements(p.items) item
                     WHERE item->>'id' = i.id::text
                   )
                 ), '[]'::jsonb) AS prepared_plans
          FROM logistics.transport_scan_items i
          LEFT JOIN sales.clients_addresses a ON a.id = i.address_id
          LEFT JOIN sales.clients c ON c.id = a.client_id
          WHERE i.confirmed = true
          ORDER BY i.loaded_date DESC NULLS LAST, i.created_at DESC
        `);

    res.json(result.rows.map((row) => ({
      ...row,
      loaded_date: row.loaded_date instanceof Date
        ? row.loaded_date.toISOString().slice(0, 10)
        : row.loaded_date == null ? null : String(row.loaded_date).slice(0, 10),
      prepared: Array.isArray(row.prepared_plans) && row.prepared_plans.length > 0,
    })));
  } catch (error) {
    console.error("List saved transport orders error:", error);
    res.status(500).json({ error: "Failed to load saved transport orders" });
  }
}

export async function deleteSavedOrder(req: Request, res: Response): Promise<void> {
  try {
    const type = req.params.type;
    const id = req.params.orderId;
    if (type !== "scanned" && type !== "generated") {
      res.status(400).json({ error: "Invalid saved order type" });
      return;
    }
    await ensureTransportScanTables();
    await ensureTransportOnlyOrdersTable();
    const result = type === "generated"
      ? await pool.query(
          "DELETE FROM logistics.transport_only_orders WHERE id = $1::uuid RETURNING id",
          [id],
        )
      : await pool.query(
          "DELETE FROM logistics.transport_scan_items WHERE id = $1::bigint AND confirmed = true RETURNING id",
          [id],
        );
    if (!result.rows.length) {
      res.status(404).json({ error: "Saved order not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error("Delete saved transport order error:", error);
    res.status(500).json({ error: "Failed to delete saved transport order" });
  }
}

export async function updateSavedOrderDate(req: Request, res: Response): Promise<void> {
  try {
    const type = req.params.type;
    const id = req.params.orderId;
    const loadedDate = req.body?.loadedDate;
    if ((type !== "scanned" && type !== "generated") || !validDate(loadedDate)) {
      res.status(400).json({ error: "A valid order type and loading date are required" });
      return;
    }
    await ensureTransportScanTables();
    await ensureTransportOnlyOrdersTable();
    const result = type === "generated"
      ? await pool.query(`
          UPDATE logistics.transport_only_orders
          SET loaded_date = $2::date,
              order_data = jsonb_set(order_data, '{loaded_date}', to_jsonb($2::text)),
              updated_at = NOW()
          WHERE id = $1::uuid
          RETURNING id
        `, [id, loadedDate])
      : await pool.query(`
          UPDATE logistics.transport_scan_items
          SET loaded_date = $2::date
          WHERE id = $1::bigint AND confirmed = true
          RETURNING id
        `, [id, loadedDate]);
    if (!result.rows.length) {
      res.status(404).json({ error: "Saved order not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error("Update saved transport order date error:", error);
    res.status(500).json({ error: "Failed to update saved transport order date" });
  }
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
