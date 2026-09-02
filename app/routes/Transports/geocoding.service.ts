export interface GeocodableAddress {
  address: string | null;
  city: string | null;
  postal_code: string | null;
  province: string | null;
  country: string | null;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface DetailedCoordinates extends Coordinates {
  displayName: string;
  matchStrategy: string;
  matchedPostalCode: string | null;
  matchedCountryCode: string | null;
  matchedHouseNumber: string | null;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REQUEST_INTERVAL_MS = 1_100;
let nextNominatimRequestAt = 0;

async function waitForNominatimRateLimit(): Promise<void> {
  const delay = Math.max(0, nextNominatimRequestAt - Date.now());
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  nextNominatimRequestAt = Date.now() + NOMINATIM_REQUEST_INTERVAL_MS;
}

export async function geocodeAddressDetailed(address: GeocodableAddress): Promise<DetailedCoordinates | null> {
  const fullAddress = [address.address, address.city, address.postal_code, address.province, address.country]
    .filter(Boolean)
    .join(", ");
  const fallbackAddress = [address.postal_code, address.city, address.province, address.country]
    .filter(Boolean)
    .join(", ");
  const normalizedStreet = address.address
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bO\.?$/i, "Ouest")
    .replace(/\bE\.?$/i, "Est")
    .replace(/[^a-z0-9 ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const streetAndCity = [normalizedStreet, address.city, address.province, address.country]
    .filter(Boolean)
    .join(", ");
  const streetAndPostalCode = [normalizedStreet, address.postal_code, address.country]
    .filter(Boolean)
    .join(", ");
  const postalCodeOnly = [address.postal_code, address.country]
    .filter(Boolean)
    .join(", ");

  const queries = [
    ["full-address", fullAddress],
    ["street-city", streetAndCity],
    ["postal-city", fallbackAddress],
    ["street-postal", streetAndPostalCode],
    ["postal-only", postalCodeOnly],
  ] as const;

  for (const [matchStrategy, query] of queries) {
    if (!query) continue;
    await waitForNominatimRateLimit();
    const params = new URLSearchParams({
      format: "jsonv2",
      limit: "1",
      addressdetails: "1",
      countrycodes: "ca",
      q: query,
    });
    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetch(`${NOMINATIM_URL}?${params}`, {
        headers: { "User-Agent": "VegibecTransportPrototype/1.0 (internal logistics planning)" },
      });
      if (![429, 502, 503, 504].includes(response.status)) break;

      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const retryDelay = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1_000
        : 5_000 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
    if (!response) throw new Error("Geocoding request did not run");
    if (!response.ok) throw new Error(`Geocoding request failed: ${response.status}`);
    const results = await response.json() as Array<{
      lat: string;
      lon: string;
      display_name?: string;
      address?: {
        postcode?: string;
        country_code?: string;
        house_number?: string;
      };
    }>;
    const result = results[0];
    if (result) {
      return {
        latitude: Number(result.lat),
        longitude: Number(result.lon),
        displayName: result.display_name ?? query,
        matchStrategy,
        matchedPostalCode: result.address?.postcode ?? null,
        matchedCountryCode: result.address?.country_code ?? null,
        matchedHouseNumber: result.address?.house_number ?? null,
      };
    }
  }

  return null;
}

export async function geocodeAddress(address: GeocodableAddress): Promise<Coordinates | null> {
  const result = await geocodeAddressDetailed(address);
  return result
    ? { latitude: result.latitude, longitude: result.longitude }
    : null;
}
