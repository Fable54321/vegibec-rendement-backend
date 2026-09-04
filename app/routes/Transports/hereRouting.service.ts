import type { RouteLocation } from "./osrm.service";
import { decode } from "@here/flexpolyline";

interface HereSummary {
  duration?: number;
  baseDuration?: number;
  length?: number;
}

interface HereNotice {
  title?: string;
  code?: string;
  severity?: string;
}

interface HereSection {
  id?: string;
  type?: string;
  polyline?: string;
  summary?: HereSummary;
  notices?: HereNotice[];
  departure?: unknown;
  arrival?: unknown;
  actions?: HereAction[];
}

interface HereAction {
  action?: string;
  direction?: string;
  instruction?: string;
  duration?: number;
  length?: number;
}

interface HereRoute {
  id?: string;
  sections?: HereSection[];
  notices?: HereNotice[];
}

interface HereRoutesResponse {
  routes?: HereRoute[];
  notices?: HereNotice[];
  title?: string;
  status?: number;
  code?: string;
  cause?: string;
  action?: string;
}

export interface HereFinalRouteResult {
  provider: "here";
  transportMode: "car" | "truck";
  avoidedFeatures: string[];
  durationSeconds: number;
  baseDurationSeconds: number;
  trafficDelaySeconds: number;
  distanceMeters: number;
  sections: HereSection[];
  notices: HereNotice[];
  geometry: { type: "LineString"; coordinates: [number, number][] };
  steps: Array<{
    legIndex: number;
    distanceMeters: number;
    durationSeconds: number;
    streetName: string;
    maneuverType: string;
    maneuverModifier: string | null;
    exit: number | null;
    instruction: string | null;
  }>;
}

const HERE_ROUTING_URL = "https://router.hereapi.com/v8/routes";
const routeCache = new Map<string, { expiresAt: number; value: HereFinalRouteResult }>();
const inFlightRoutes = new Map<string, Promise<HereFinalRouteResult>>();

function getTransportMode(): "car" | "truck" {
  return process.env.HERE_TRANSPORT_MODE?.toLowerCase() === "truck"
    ? "truck"
    : "car";
}

function getAvoidedFeatures(): string[] {
  return (process.env.HERE_AVOID_FEATURES ?? "tollRoad,ferry")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
}

export async function getHereFinalRoute(
  orderedLocations: RouteLocation[]
): Promise<HereFinalRouteResult> {
  const apiKey = process.env.HERE_API_KEY;

  if (!apiKey) {
    throw new Error("HERE_API_KEY is not configured");
  }

  if (orderedLocations.length < 2) {
    throw new Error("At least 2 ordered locations are required for HERE routing");
  }

  const transportMode = getTransportMode();
  const avoidedFeatures = getAvoidedFeatures();
  const cacheKey = JSON.stringify({
    transportMode,
    avoidedFeatures,
    vehicle: getVehicleParameters(),
    locations: orderedLocations.map(({ lat, lng }) => [lat.toFixed(5), lng.toFixed(5)]),
  });
  const cached = routeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const inFlight = inFlightRoutes.get(cacheKey);
  if (inFlight) return inFlight;

  const request = requestHereRoute(orderedLocations, transportMode, avoidedFeatures)
    .then((value) => {
      const ttl = Math.max(0, Number(process.env.HERE_ROUTE_CACHE_TTL_MS) || 900_000);
      routeCache.set(cacheKey, { expiresAt: Date.now() + ttl, value });
      if (routeCache.size > 200) routeCache.delete(routeCache.keys().next().value!);
      return value;
    })
    .finally(() => inFlightRoutes.delete(cacheKey));
  inFlightRoutes.set(cacheKey, request);
  return request;
}

async function requestHereRoute(
  orderedLocations: RouteLocation[],
  transportMode: "car" | "truck",
  avoidedFeatures: string[],
): Promise<HereFinalRouteResult> {
  const apiKey = process.env.HERE_API_KEY!;
  const first = orderedLocations[0];
  const last = orderedLocations[orderedLocations.length - 1];
  const params = new URLSearchParams({
    origin: `${first.lat},${first.lng}`,
    destination: `${last.lat},${last.lng}`,
    transportMode,
    routingMode: "fast",
    departureTime: "now",
    return: "polyline,summary,actions,instructions",
    lang: "fr-FR",
    units: "metric",
    apiKey,
  });

  Object.entries(getVehicleParameters()).forEach(([key, value]) => {
    params.set(`vehicle[${key}]`, value);
  });

  for (const location of orderedLocations.slice(1, -1)) {
    params.append("via", `${location.lat},${location.lng}`);
  }

  if (avoidedFeatures.length) {
    params.set("avoid[features]", avoidedFeatures.join(","));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const requestUrl = `${HERE_ROUTING_URL}?${params.toString()}`;
  const safeRequestUrl = redactApiKey(requestUrl);

  try {
    console.info("HERE route request", {
      url: safeRequestUrl,
      transportMode,
      avoidedFeatures,
      vehicleParameters: getVehicleParameters(),
      waypointCount: orderedLocations.length,
    });

    const response = await fetch(requestUrl, {
      signal: controller.signal,
    });
    const responseText = await response.text();
    let data: HereRoutesResponse;
    try {
      data = JSON.parse(responseText) as HereRoutesResponse;
    } catch {
      console.error("HERE route returned a non-JSON response", {
        status: response.status,
        statusText: response.statusText,
        url: safeRequestUrl,
        responseBody: responseText.slice(0, 4_000),
      });
      throw new Error(`HERE routing returned invalid JSON (${response.status})`);
    }

    if (!response.ok) {
      console.error("HERE route request rejected", {
        status: response.status,
        statusText: response.statusText,
        url: safeRequestUrl,
        response: data,
      });
      const details = data.title ?? data.cause ?? data.action ?? data.code;
      throw new Error(
        `HERE routing request failed (${response.status})${details ? `: ${details}` : ""}`
      );
    }

    const route = data.routes?.[0];
    const sections = route?.sections ?? [];

    if (!route || sections.length === 0) {
      console.error("HERE route response contained no usable route", {
        url: safeRequestUrl,
        response: data,
      });
      throw new Error("HERE did not return a route");
    }

    const durationSeconds = sections.reduce(
      (total, section) => total + (section.summary?.duration ?? 0),
      0
    );
    const baseDurationSeconds = sections.reduce(
      (total, section) => total + (section.summary?.baseDuration ?? 0),
      0
    );
    const distanceMeters = sections.reduce(
      (total, section) => total + (section.summary?.length ?? 0),
      0
    );
    const notices = [
      ...(data.notices ?? []),
      ...(route.notices ?? []),
      ...sections.flatMap((section) => section.notices ?? []),
    ];
    const coordinates = sections.flatMap((section, sectionIndex) => {
      if (!section.polyline) return [];
      const decoded = decode(section.polyline).polyline.map(
        ([lat, lng]) => [lng, lat] as [number, number],
      );
      return sectionIndex === 0 ? decoded : decoded.slice(1);
    });
    const steps = sections.flatMap((section, legIndex) =>
      (section.actions ?? []).map((action) => ({
        legIndex,
        distanceMeters: action.length ?? 0,
        durationSeconds: action.duration ?? 0,
        streetName: "",
        maneuverType: action.action ?? "continue",
        maneuverModifier: action.direction ?? null,
        exit: null,
        instruction: action.instruction ?? null,
      })),
    );

    if (coordinates.length < 2) throw new Error("HERE did not return route geometry");

    console.info("HERE route response accepted", {
      status: response.status,
      sectionCount: sections.length,
      coordinateCount: coordinates.length,
      actionCount: steps.length,
      distanceMeters,
      durationSeconds,
      noticeCount: notices.length,
    });

    return {
      provider: "here",
      transportMode,
      avoidedFeatures,
      durationSeconds,
      baseDurationSeconds,
      trafficDelaySeconds: Math.max(0, durationSeconds - baseDurationSeconds),
      distanceMeters,
      sections,
      notices,
      geometry: { type: "LineString", coordinates },
      steps,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function redactApiKey(url: string) {
  const safeUrl = new URL(url);
  if (safeUrl.searchParams.has("apiKey")) {
    safeUrl.searchParams.set("apiKey", "[REDACTED]");
  }
  return safeUrl.toString();
}

function getVehicleParameters(): Record<string, string> {
  const variables: Record<string, string | undefined> = {
    grossWeight: process.env.HERE_VEHICLE_GROSS_WEIGHT,
    currentWeight: process.env.HERE_VEHICLE_CURRENT_WEIGHT,
    height: process.env.HERE_VEHICLE_HEIGHT_CM,
    width: process.env.HERE_VEHICLE_WIDTH_CM,
    length: process.env.HERE_VEHICLE_LENGTH_CM,
    axleCount: process.env.HERE_VEHICLE_AXLE_COUNT,
    trailerCount: process.env.HERE_VEHICLE_TRAILER_COUNT,
    trailerAxleCount: process.env.HERE_VEHICLE_TRAILER_AXLE_COUNT,
  };
  return Object.fromEntries(
    Object.entries(variables).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}
