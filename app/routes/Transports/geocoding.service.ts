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

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REQUEST_INTERVAL_MS = 1_100;
let nextNominatimRequestAt = 0;

async function waitForNominatimRateLimit(): Promise<void> {
  const delay = Math.max(0, nextNominatimRequestAt - Date.now());
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  nextNominatimRequestAt = Date.now() + NOMINATIM_REQUEST_INTERVAL_MS;
}

export async function geocodeAddress(address: GeocodableAddress): Promise<Coordinates | null> {
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

  for (const query of [fullAddress, streetAndCity, fallbackAddress]) {
    if (!query) continue;
    await waitForNominatimRateLimit();
    const params = new URLSearchParams({ format: "jsonv2", limit: "1", countrycodes: "ca", q: query });
    const response = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { "User-Agent": "VegibecTransportPrototype/1.0 (internal logistics planning)" },
    });
    if (!response.ok) throw new Error(`Geocoding request failed: ${response.status}`);
    const results = await response.json() as Array<{ lat: string; lon: string }>;
    const result = results[0];
    if (result) return { latitude: Number(result.lat), longitude: Number(result.lon) };
  }

  return null;
}
