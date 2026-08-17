import type { Request, Response } from "express";
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
        a.latitude, a.longitude
      FROM sales.clients_addresses a
      JOIN sales.clients c ON c.id = a.client_id
      WHERE a.address IS NOT NULL OR a.city IS NOT NULL OR a.postal_code IS NOT NULL
      ORDER BY lower(c.name), a.site_number NULLS LAST, a.id
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
        COALESCE(SUM(i.quantity_ordered * fp.weight), 0) AS estimated_weight,
        COALESCE(SUM(i.actual_pallets), 0) AS actual_pallets
      FROM sales.orders o
      JOIN sales.clients_addresses a ON a.id = o.client_address_id
      LEFT JOIN sales.order_items i ON i.order_id = o.id
      LEFT JOIN public.finished_product fp ON fp.id = i.finished_product_id
      WHERE o.status IN ('a-faire', 'en-cours')
      GROUP BY o.id, a.id
      ORDER BY o.loaded_date, o.trip_number, o.id
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
