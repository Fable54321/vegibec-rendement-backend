// src/weather/weatherParsers.ts

const frenchMonths: Record<string, number> = {
  janv: 0,
  févr: 1,
  fevr: 1,
  mars: 2,
  avr: 3,
  mai: 4,
  juin: 5,
  juil: 6,
  août: 7,
  aout: 7,
  sept: 8,
  oct: 9,
  nov: 10,
  déc: 11,
  dec: 11,
};

export function parseForecastDate(rawDayLabel: string, referenceDate = new Date()) {
  // Example: "23 mai sam."
  const match = rawDayLabel
    .toLowerCase()
    .normalize("NFC")
    .match(/(\d{1,2})\s+([a-zéûôîàèù]+)/i);

  if (!match) {
    throw new Error(`Could not parse forecast day label: ${rawDayLabel}`);
  }

  const day = Number(match[1]);
  const monthText = match[2];
  const month = frenchMonths[monthText];

  if (month === undefined) {
    throw new Error(`Unknown French month in label: ${rawDayLabel}`);
  }

  let year = referenceDate.getFullYear();

  // Handles edge case like scraping Dec 29 and getting Jan 2.
  const currentMonth = referenceDate.getMonth();
  if (currentMonth === 11 && month === 0) {
    year += 1;
  }

  const date = new Date(Date.UTC(year, month, day));

  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function parseTemperature(value: string) {
  const match = value.match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

export function parsePercent(value: string) {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : null;
}

export function parseWind(value: string) {
  // Example: "14 km/h NE"
  const speedMatch = value.match(/(\d+)\s*km\/h/i);
  const directionMatch = value.match(/km\/h\s+([A-ZÀ-ÿ]+)/i);

  return {
    windSpeedKmh: speedMatch ? Number(speedMatch[1]) : null,
    windDirection: directionMatch ? directionMatch[1] : null,
  };
}

export function parseWindGust(value: string) {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : null;
}