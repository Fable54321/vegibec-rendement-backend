const SHIPPING_DATE_LABEL = /shipping\s*\/?\s*chargee?/i;
const OCR_ISO_DATE =
  /[0-9oil]{4}\s*[-/.]\s*[0-9oil]{1,2}\s*[-/.]\s*[0-9oil]{1,2}/i;

export function resolveTransportDocumentDate(
  loadedDate: unknown,
  rawText: unknown,
): string | null {
  const normalizedLoadedDate = normalizeIsoDate(loadedDate);
  if (normalizedLoadedDate) return normalizedLoadedDate;
  if (typeof rawText !== "string") return null;

  const normalizedText = removeDiacritics(rawText);
  const labelMatch = SHIPPING_DATE_LABEL.exec(normalizedText);
  if (!labelMatch) return null;

  // On Vegibec loading slips, the date is directly below this heading. Limit
  // the search area so another date elsewhere on the document is never used.
  const fieldText = normalizedText.slice(
    labelMatch.index + labelMatch[0].length,
    labelMatch.index + labelMatch[0].length + 240,
  );
  return normalizeIsoDate(fieldText.match(OCR_ISO_DATE)?.[0]);
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digitCorrected = value
    .trim()
    .toLowerCase()
    .replace(/o/g, "0")
    .replace(/[il]/g, "1");
  const match = digitCorrected.match(
    /^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/,
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    return null;

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function removeDiacritics(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
