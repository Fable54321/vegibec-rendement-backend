import type { Request, Response } from "express";

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