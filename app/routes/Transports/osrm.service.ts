export interface RouteLocation {
  id: string | number;
  name: string;
  lat: number;
  lng: number;
}

interface OsrmTableResponse {
  code: string;
  message?: string;
  durations: Array<Array<number | null>>;
  distances: Array<Array<number | null>>;
}

interface OsrmRouteResponse {
  code: string;
  message?: string;
  routes?: Array<{ geometry: { type: "LineString"; coordinates: [number, number][] } }>;
}

export interface RouteMatrixResult {
  durations: Array<Array<number | null>>;
  distances: Array<Array<number | null>>;
  locations: RouteLocation[];
}

const OSRM_BASE_URL = process.env.OSRM_BASE_URL ?? "https://router.project-osrm.org";

export async function getRouteMatrix(locations: RouteLocation[]): Promise<RouteMatrixResult> {
  if (!Array.isArray(locations) || locations.length < 2) throw new Error("At least 2 locations are required");
  const coordinates = locations.map((location) => `${location.lng},${location.lat}`).join(";");
  const response = await fetch(`${OSRM_BASE_URL}/table/v1/driving/${coordinates}?annotations=duration,distance`);
  if (!response.ok) throw new Error(`OSRM request failed: ${response.status}`);
  const data = (await response.json()) as OsrmTableResponse;
  if (data.code !== "Ok") throw new Error(data.message ?? `OSRM error: ${data.code}`);
  return { durations: data.durations, distances: data.distances, locations };
}

export async function getRouteGeometry(locations: RouteLocation[]) {
  const coordinates = locations.map((location) => `${location.lng},${location.lat}`).join(";");
  const response = await fetch(`${OSRM_BASE_URL}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`);
  const data = (await response.json()) as OsrmRouteResponse;
  const geometry = data.routes?.[0]?.geometry;
  if (!response.ok || data.code !== "Ok" || !geometry) throw new Error(data.message ?? `OSRM route request failed (${response.status})`);
  return geometry;
}
