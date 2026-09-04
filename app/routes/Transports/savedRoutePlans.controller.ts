import { randomUUID } from "crypto";
import type { Request, Response } from "express";

import { pool } from "../../db";

let tablePromise: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (tablePromise) return tablePromise;
  tablePromise = pool.query(`
    CREATE SCHEMA IF NOT EXISTS logistics;
    DO $$
    BEGIN
      IF to_regclass('logistics.transport_route_plans') IS NULL
         AND to_regclass('public.transport_route_plans') IS NOT NULL THEN
        ALTER TABLE public.transport_route_plans SET SCHEMA logistics;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS logistics.transport_route_plans (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      delivery_date DATE NOT NULL,
      routes JSONB NOT NULL DEFAULT '[]'::jsonb,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS transport_route_plans_delivery_date_idx
      ON logistics.transport_route_plans (delivery_date DESC, created_at DESC);
  `).then(() => undefined).catch((error) => {
    tablePromise = null;
    throw error;
  });
  return tablePromise;
}

function mapPlan(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    deliveryDate: dateOnly(row.delivery_date),
    routes: row.routes,
    items: row.items,
    createdAt: dateTime(row.created_at),
    updatedAt: dateTime(row.updated_at),
  };
}

export async function listSavedRoutePlans(_req: Request, res: Response): Promise<void> {
  try {
    await ensureTable();
    const result = await pool.query(`
      SELECT id, name, delivery_date, routes, items, created_at, updated_at
      FROM logistics.transport_route_plans
      ORDER BY delivery_date DESC, created_at DESC
    `);
    res.json(result.rows.map(mapPlan));
  } catch (error) {
    console.error("List saved route plans error:", error);
    res.status(500).json({ error: "Failed to load saved route plans" });
  }
}

export async function createSavedRoutePlan(req: Request, res: Response): Promise<void> {
  try {
    const { name, deliveryDate, routes, items } = req.body ?? {};
    if (typeof name !== "string" || !name.trim() || !validDate(deliveryDate) || !Array.isArray(routes) || routes.length === 0 || !Array.isArray(items)) {
      res.status(400).json({ error: "A name, delivery date, routes and items are required" });
      return;
    }
    await ensureTable();
    const result = await pool.query(`
      INSERT INTO logistics.transport_route_plans (id, name, delivery_date, routes, items, created_by_user_id)
      VALUES ($1, $2, $3::date, $4::jsonb, $5::jsonb, $6)
      RETURNING id, name, delivery_date, routes, items, created_at, updated_at
    `, [randomUUID(), name.trim().slice(0, 200), deliveryDate, JSON.stringify(routes), JSON.stringify(items), req.user?.id ?? null]);
    res.status(201).json(mapPlan(result.rows[0]));
  } catch (error) {
    console.error("Create saved route plan error:", error);
    res.status(500).json({ error: "Failed to save route plan" });
  }
}

export async function updateSavedRoutePlan(req: Request, res: Response): Promise<void> {
  try {
    const { routes } = req.body ?? {};
    if (!Array.isArray(routes) || routes.length === 0) {
      res.status(400).json({ error: "Routes are required" });
      return;
    }
    await ensureTable();
    const result = await pool.query(`
      UPDATE logistics.transport_route_plans
      SET routes = $2::jsonb, updated_at = NOW()
      WHERE id = $1::uuid
      RETURNING id, name, delivery_date, routes, items, created_at, updated_at
    `, [req.params.planId, JSON.stringify(routes)]);
    if (!result.rows.length) {
      res.status(404).json({ error: "Saved route plan not found" });
      return;
    }
    res.json(mapPlan(result.rows[0]));
  } catch (error) {
    console.error("Update saved route plan error:", error);
    res.status(500).json({ error: "Failed to update route plan" });
  }
}

export async function deleteSavedRoutePlan(req: Request, res: Response): Promise<void> {
  try {
    await ensureTable();
    const result = await pool.query("DELETE FROM logistics.transport_route_plans WHERE id = $1::uuid RETURNING id", [req.params.planId]);
    if (!result.rows.length) {
      res.status(404).json({ error: "Saved route plan not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error("Delete saved route plan error:", error);
    res.status(500).json({ error: "Failed to delete route plan" });
  }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function dateOnly(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function dateTime(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}
