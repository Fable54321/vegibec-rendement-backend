const VOYAGE_LABEL_PATTERN =
  /\bN(?:O|0|°|º)\.?\s*VOYAGE\b\s*[:#-]?\s*([A-Z0-9][A-Z0-9./-]{0,29})/i;

export function normalizeTransportVoyageNumber(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const text = String(value).trim();
  if (!text) return null;

  const labelled = text.match(VOYAGE_LABEL_PATTERN)?.[1];
  if (labelled) return normalizeTransportVoyageNumber(labelled);
  if (/voyage/i.test(text)) return null;

  const compact = text.replace(/\s+/g, "").toUpperCase();
  return /\d/.test(compact) && /^[A-Z0-9][A-Z0-9./-]{0,29}$/.test(compact)
    ? compact
    : null;
}

export function extractTransportVoyageNumber(text: unknown): string | null {
  if (typeof text !== "string") return null;
  return normalizeTransportVoyageNumber(text.match(VOYAGE_LABEL_PATTERN)?.[1]);
}

export function voyageNumberFromPlanItem(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const candidate = item as Record<string, unknown>;
  return (
    normalizeTransportVoyageNumber(candidate.recognized_voyage_number) ??
    normalizeTransportVoyageNumber(candidate.voyageNumber) ??
    normalizeTransportVoyageNumber(candidate.voyage_number) ??
    extractTransportVoyageNumber(candidate.recognized_text)
  );
}

export function findDuplicateTransportVoyageNumbers(
  items: unknown[],
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const voyageNumber = voyageNumberFromPlanItem(item);
    if (!voyageNumber) continue;
    if (seen.has(voyageNumber)) duplicates.add(voyageNumber);
    seen.add(voyageNumber);
  }
  return [...duplicates];
}
