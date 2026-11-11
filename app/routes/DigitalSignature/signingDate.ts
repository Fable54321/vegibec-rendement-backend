export type SigningDateResult =
  | { ok: true; date: Date; isManual: boolean }
  | { ok: false; error: string };

const INVALID_SIGNING_DATE =
  "La date de signature doit être une date valide au format AAAA-MM-JJ";

export function resolveSigningDate(
  value: unknown,
  currentDate: Date = new Date()
): SigningDateResult {
  if (value === undefined || value === null) {
    return { ok: true, date: new Date(currentDate.getTime()), isManual: false };
  }

  if (typeof value !== "string") {
    return { ok: false, error: INVALID_SIGNING_DATE };
  }

  const normalizedValue = value.trim();

  if (normalizedValue === "") {
    return { ok: true, date: new Date(currentDate.getTime()), isManual: false };
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizedValue);

  if (!match) {
    return { ok: false, error: INVALID_SIGNING_DATE };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year < 1000) {
    return { ok: false, error: INVALID_SIGNING_DATE };
  }

  // A date-only value is anchored at noon UTC so it remains on the selected
  // calendar day when rendered in the application's Toronto timezone.
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, error: INVALID_SIGNING_DATE };
  }

  return { ok: true, date, isManual: true };
}
