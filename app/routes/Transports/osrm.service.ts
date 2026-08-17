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

export interface RouteMatrixResult {
  durations: Array<Array<number | null>>;
  distances: Array<Array<number | null>>;
  locations: RouteLocation[];
}

const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL ?? "https://router.project-osrm.org";

export async function getRouteMatrix(
  locations: RouteLocation[]
): Promise<RouteMatrixResult> {
  if (!Array.isArray(locations) || locations.length < 2) {
    throw new Error("At least 2 locations are required");
  }

  const coordinates = locations
    .map((location) => `${location.lng},${location.lat}`)
    .join(";");

  const url =
    `${OSRM_BASE_URL}/table/v1/driving/${coordinates}` +
    `?annotations=duration,distance`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`OSRM request failed: ${response.status}`);
  }

  const data = (await response.json()) as OsrmTableResponse;

  if (data.code !== "Ok") {
    throw new Error(data.message ?? `OSRM error: ${data.code}`);
  }

  return {
    durations: data.durations,
    distances: data.distances,
    locations,
  };
}