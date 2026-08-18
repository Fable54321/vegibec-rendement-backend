import type { Request, Response } from "express";
import crypto from "crypto";
import { pool } from "../../db";
import { geocodeAddress } from "./geocoding.service";

import {
  getRouteMatrix,
  type RouteLocation,
} from "../Transports/osrm.service";

import {
  optimizeRoundTrip,
} from "../Transports/routeOptimizer.service";

interface OptimizeRouteBody {
  locations: RouteLocation[];
}

async function ensureTransportScanTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.transport_scan_sessions (
      token TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '8 hours'
    );
    CREATE TABLE IF NOT EXISTS public.transport_scan_items (
      id BIGSERIAL PRIMARY KEY,
      session_token TEXT NOT NULL REFERENCES public.transport_scan_sessions(token) ON DELETE CASCADE,
      address_id INTEGER NOT NULL REFERENCES sales.clients_addresses(id),
      pallets INTEGER NOT NULL CHECK (pallets BETWEEN 1 AND 30),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS transport_scan_items_session_idx
      ON public.transport_scan_items(session_token, id);
  `);
}

export async function createScanSession(req: Request, res: Response): Promise<void> {
  try {
    await ensureTransportScanTables();
    const token = crypto.randomBytes(18).toString("base64url");
    const result = await pool.query(
      `INSERT INTO public.transport_scan_sessions (token, owner_user_id)
       VALUES ($1, $2) RETURNING token, expires_at`,
      [token, req.user!.id],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Create transport scan session error:", error);
    res.status(500).json({ error: "Failed to create scan session" });
  }
}

export async function getScanSession(req: Request, res: Response): Promise<void> {
  try {
    await ensureTransportScanTables();
    const session = await pool.query(
      `SELECT token, expires_at FROM public.transport_scan_sessions
       WHERE token = $1 AND owner_user_id = $2 AND expires_at > NOW()`,
      [req.params.token, req.user!.id],
    );
    if (!session.rows.length) { res.status(404).json({ error: "Scan session not found or expired" }); return; }
    const items = await pool.query(
      `SELECT i.id, i.address_id, i.pallets, i.created_at, c.name AS client_name,
              a.site_name, a.site_number, a.city
       FROM public.transport_scan_items i
       JOIN sales.clients_addresses a ON a.id = i.address_id
       JOIN sales.clients c ON c.id = a.client_id
       WHERE i.session_token = $1 ORDER BY i.id`,
      [req.params.token],
    );
    res.json({ ...session.rows[0], items: items.rows });
  } catch (error) {
    console.error("Get transport scan session error:", error);
    res.status(500).json({ error: "Failed to load scan session" });
  }
}

export async function addScanSessionItem(req: Request, res: Response): Promise<void> {
  try {
    await ensureTransportScanTables();
    const addressId = Number(req.body?.addressId);
    const pallets = Number(req.body?.pallets);
    if (!Number.isSafeInteger(addressId) || addressId < 1 || !Number.isSafeInteger(pallets) || pallets < 1 || pallets > 30) {
      res.status(400).json({ error: "A valid address and 1 to 30 pallets are required" }); return;
    }
    const session = await pool.query(
      `SELECT token FROM public.transport_scan_sessions
       WHERE token = $1 AND owner_user_id = $2 AND expires_at > NOW()`,
      [req.params.token, req.user!.id],
    );
    if (!session.rows.length) { res.status(404).json({ error: "Scan session not found or expired" }); return; }
    const result = await pool.query(
      `INSERT INTO public.transport_scan_items (session_token, address_id, pallets)
       SELECT $1, a.id, $3 FROM sales.clients_addresses a WHERE a.id = $2
       RETURNING id, address_id, pallets, created_at`,
      [req.params.token, addressId, pallets],
    );
    if (!result.rows.length) { res.status(404).json({ error: "Client address not found" }); return; }
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add transport scan item error:", error);
    res.status(500).json({ error: "Failed to add scanned order" });
  }
}

export async function optimizeRoute(
  req: Request<{}, {}, OptimizeRouteBody>,
  res: Response
): Promise<void> {
  try {
    const { locations } = req.body;

    if (!Array.isArray(locations) || locations.length < 2) {
      res.status(400).json({
        error: "At least 2 locations are required",
      });

      return;
    }

    const matrixResult = await getRouteMatrix(locations);

    const optimization = optimizeRoundTrip(
      matrixResult.durations
    );

    const orderedLocations = optimization.route.map(
      (index) => locations[index]
    );

    const legs = [];

    for (let i = 0; i < optimization.route.length - 1; i++) {
      const fromIndex = optimization.route[i];
      const toIndex = optimization.route[i + 1];

      const duration =
        matrixResult.durations[fromIndex]?.[toIndex];

      const distance =
        matrixResult.distances[fromIndex]?.[toIndex];

      if (duration == null || distance == null) {
        continue;
      }

      legs.push({
        from: locations[fromIndex],
        to: locations[toIndex],

        durationSeconds: duration,
        durationMinutes: Math.round(duration / 60),

        distanceMeters: distance,
        distanceKm: Math.round(distance / 100) / 10,
      });
    }

    res.json({
      route: orderedLocations,
      routeIndexes: optimization.route,
      legs,

      totalDurationSeconds:
        optimization.totalDuration,

      totalDurationMinutes:
        Math.round(optimization.totalDuration / 60),

      durations: matrixResult.durations,
      distances: matrixResult.distances,
    });
  } catch (error: unknown) {
    console.error("Route optimization error:", error);

    const message =
      error instanceof Error
        ? error.message
        : "Unknown error";

    res.status(500).json({
      error: "Failed to optimize route",
      details: message,
    });
  }
}

export async function getClientStops(_req: Request, res: Response): Promise<void> {
  try {
    const result = await pool.query(`
      SELECT a.id, a.client_id, c.name AS client_name, a.site_number, a.site_name,
        a.address, a.city, a.postal_code, a.province, a.country,
        a.latitude, a.longitude, a.delivery_region_id,
        dr.name AS delivery_region_name, dr.position_order AS delivery_region_position_order
      FROM sales.clients_addresses a
      JOIN sales.clients c ON c.id = a.client_id
      LEFT JOIN sales.delivery_regions dr ON dr.id = a.delivery_region_id
      WHERE a.address IS NOT NULL OR a.city IS NOT NULL OR a.postal_code IS NOT NULL
      ORDER BY dr.position_order NULLS LAST, lower(dr.name) NULLS LAST, lower(c.name), a.site_number NULLS LAST, a.id
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("Transport client stops error:", error);
    res.status(500).json({ error: "Failed to load client stops" });
  }
}

export async function resolveClientLocations(req: Request, res: Response): Promise<void> {
  try {
    const addressIds = Array.isArray(req.body?.addressIds)
      ? [...new Set(req.body.addressIds.map(Number).filter((id: number) => Number.isSafeInteger(id) && id > 0))]
      : [];
    if (!addressIds.length || addressIds.length > 8) {
      res.status(400).json({ error: "Select between 1 and 8 client addresses" });
      return;
    }
    const result = await pool.query(`
      SELECT a.id, c.name AS client_name, a.site_number, a.site_name,
        a.address, a.city, a.postal_code, a.province, a.country,
        a.latitude, a.longitude
      FROM sales.clients_addresses a
      JOIN sales.clients c ON c.id = a.client_id
      WHERE a.id = ANY($1::int[])
    `, [addressIds]);
    if (result.rows.length !== addressIds.length) {
      res.status(404).json({ error: "One or more client addresses were not found" });
      return;
    }
    const locations = [];
    let geocodedAddress = false;
    for (const addressId of addressIds) {
      const address = result.rows.find((row) => Number(row.id) === addressId);
      if (address.latitude == null || address.longitude == null) {
        if (geocodedAddress) await new Promise((resolve) => setTimeout(resolve, 1_100));
        const coordinates = await geocodeAddress(address);
        if (!coordinates) {
          res.status(422).json({ error: `Unable to geolocate ${address.client_name}` });
          return;
        }
        address.latitude = coordinates.latitude;
        address.longitude = coordinates.longitude;
        geocodedAddress = true;
        await pool.query(
          `UPDATE sales.clients_addresses SET latitude = $2, longitude = $3 WHERE id = $1`,
          [address.id, coordinates.latitude, coordinates.longitude],
        );
      }
      const site = [address.site_name, address.site_number != null ? `site ${address.site_number}` : null]
        .filter(Boolean).join(" — ");
      locations.push({
        id: address.id,
        name: [address.client_name, site || address.city].filter(Boolean).join(" — "),
        lat: Number(address.latitude),
        lng: Number(address.longitude),
      });
    }
    res.json(locations);
  } catch (error) {
    console.error("Resolve client locations error:", error);
    res.status(500).json({ error: "Failed to resolve client locations" });
  }
}

export async function getTransportOrders(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const result = await pool.query(`
      SELECT
        o.id,
        o.order_reference,
        o.trip_number,
        o.client_name,
        o.loaded_date,
        o.status,
        a.id AS address_id,
        a.site_number,
        a.site_name,
        a.address,
        a.city,
        a.postal_code,
        a.province,
        a.country,
        a.latitude,
        a.longitude,
        a.delivery_region_id,
        dr.name AS delivery_region_name,
        dr.position_order AS delivery_region_position_order,
        COALESCE(SUM(i.quantity_ordered * fp.weight), 0) AS estimated_weight,
        COALESCE(SUM(i.actual_pallets), 0) AS actual_pallets
      FROM sales.orders o
      JOIN sales.clients_addresses a ON a.id = o.client_address_id
      LEFT JOIN sales.delivery_regions dr ON dr.id = a.delivery_region_id
      LEFT JOIN sales.order_items i ON i.order_id = o.id
      LEFT JOIN public.finished_product fp ON fp.id = i.finished_product_id
      WHERE o.status IN ('a-faire', 'en-cours')
      GROUP BY o.id, a.id, dr.id
      ORDER BY dr.position_order NULLS LAST, lower(dr.name) NULLS LAST, o.loaded_date, o.trip_number, o.id
    `);
    let geocodedAddress = false;
    for (const order of result.rows) {
      if (order.latitude != null && order.longitude != null) continue;
      if (geocodedAddress) await new Promise((resolve) => setTimeout(resolve, 1_100));
      const coordinates = await geocodeAddress(order);
      if (!coordinates) continue;
      geocodedAddress = true;
      order.latitude = coordinates.latitude;
      order.longitude = coordinates.longitude;
      await pool.query(
        `UPDATE sales.clients_addresses SET latitude = $2, longitude = $3 WHERE id = $1`,
        [order.address_id, coordinates.latitude, coordinates.longitude],
      );
    }
    res.json(result.rows);
  } catch (error) {
    console.error("Transport orders error:", error);
    res.status(500).json({ error: "Failed to load transport orders" });
  }
}
