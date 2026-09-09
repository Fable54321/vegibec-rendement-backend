import { randomUUID } from "crypto";
import type { Request, Response } from "express";

import { pool } from "../../db";

let tablePromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (tablePromise) return tablePromise;
  tablePromise = pool.query(`
    CREATE SCHEMA IF NOT EXISTS logistics;
    CREATE TABLE IF NOT EXISTS logistics.transport_only_orders (
      id UUID PRIMARY KEY,
      generated_id BIGINT,
      address_id INTEGER REFERENCES sales.clients_addresses(id) ON DELETE SET NULL,
      loaded_date DATE NOT NULL,
      pallets INTEGER NOT NULL CHECK (pallets BETWEEN 1 AND 999),
      estimated_weight NUMERIC(14, 3) NOT NULL DEFAULT 0,
      product_matches JSONB NOT NULL DEFAULT '[]'::jsonb,
      order_data JSONB NOT NULL,
      created_by_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS transport_only_orders_loaded_date_idx
      ON logistics.transport_only_orders (loaded_date DESC, created_at DESC);
  `).then(() => undefined).catch((error) => {
    tablePromise = null;
    throw error;
  });
  return tablePromise;
}

export async function createTransportOnlyOrders(req: Request, res: Response): Promise<void> {
  try {
    const orders = req.body?.orders;
    if (!Array.isArray(orders) || orders.length < 1 || orders.length > 100) {
      res.status(400).json({ error: "Between 1 and 100 generated orders are required" });
      return;
    }
    const invalid = orders.some((order) =>
      !validDate(order?.loaded_date) ||
      !Number.isSafeInteger(Number(order?.pallets)) ||
      Number(order.pallets) < 1 ||
      Number(order.pallets) > 999 ||
      !Number.isFinite(Number(order?.estimated_weight)) ||
      Number(order.estimated_weight) < 0 ||
      !Array.isArray(order?.product_matches),
    );
    if (invalid) {
      res.status(400).json({ error: "Each generated order requires a loading date, pallets, weight, and products" });
      return;
    }

    await ensureTable();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const saved = [];
      for (const order of orders) {
        const result = await client.query(`
          INSERT INTO logistics.transport_only_orders
            (id, generated_id, address_id, loaded_date, pallets, estimated_weight,
             product_matches, order_data, created_by_user_id)
          VALUES ($1, $2, $3, $4::date, $5, $6, $7::jsonb, $8::jsonb, $9)
          RETURNING id, generated_id, address_id, loaded_date, pallets,
                    estimated_weight, product_matches, order_data, created_at
        `, [
          randomUUID(),
          Number.isSafeInteger(Number(order.id)) ? Number(order.id) : null,
          Number.isSafeInteger(Number(order.address_id)) ? Number(order.address_id) : null,
          order.loaded_date,
          Number(order.pallets),
          Number(order.estimated_weight),
          JSON.stringify(order.product_matches),
          JSON.stringify(order),
          req.user?.id ?? null,
        ]);
        saved.push(result.rows[0]);
      }
      await client.query("COMMIT");
      res.status(201).json(saved);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Create transport-only orders error:", error);
    res.status(500).json({ error: "Failed to save generated transport orders" });
  }
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
