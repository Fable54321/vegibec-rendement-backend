import type { RouteLocation } from "./osrm.service";

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
}

const HERE_ROUTING_URL = "https://router.hereapi.com/v8/routes";

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
  const first = orderedLocations[0];
  const last = orderedLocations[orderedLocations.length - 1];
  const params = new URLSearchParams({
    origin: `${first.lat},${first.lng}`,
    destination: `${last.lat},${last.lng}`,
    transportMode,
    routingMode: "fast",
    departureTime: "now",
    return: "polyline,summary",
    apiKey,
  });

  for (const location of orderedLocations.slice(1, -1)) {
    params.append("via", `${location.lat},${location.lng}`);
  }

  if (avoidedFeatures.length) {
    params.set("avoid[features]", avoidedFeatures.join(","));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(`${HERE_ROUTING_URL}?${params.toString()}`, {
      signal: controller.signal,
    });
    const data = (await response.json()) as HereRoutesResponse;

    if (!response.ok) {
      const details = data.title ?? data.cause ?? data.action ?? data.code;
      throw new Error(
        `HERE routing request failed (${response.status})${details ? `: ${details}` : ""}`
      );
    }

    const route = data.routes?.[0];
    const sections = route?.sections ?? [];

    if (!route || sections.length === 0) {
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
    };
  } finally {
    clearTimeout(timeout);
  }
}
