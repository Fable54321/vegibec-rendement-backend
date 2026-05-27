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
  console.log("[weather-parser] Parsing forecast date", {
    rawDayLabel,
    referenceDate: referenceDate.toISOString(),
    referenceTimezoneOffsetMinutes: referenceDate.getTimezoneOffset(),
  });

  // Example: "23 mai sam."
  const match = rawDayLabel
    .toLowerCase()
    .normalize("NFC")
    .match(/(\d{1,2})\s+([a-zéûôîàèù]+)/i);

  if (!match) {
    console.warn("[weather-parser] Forecast day label did not match expected format", {
      rawDayLabel,
    });
    throw new Error(`Could not parse forecast day label: ${rawDayLabel}`);
  }

  const day = Number(match[1]);
  const monthText = match[2];
  const month = frenchMonths[monthText];

  if (month === undefined) {
    console.warn("[weather-parser] Unknown French month", {
      rawDayLabel,
      monthText,
      knownMonths: Object.keys(frenchMonths),
    });
    throw new Error(`Unknown French month in label: ${rawDayLabel}`);
  }

  let year = referenceDate.getFullYear();

  // Handles edge case like scraping Dec 29 and getting Jan 2.
  const currentMonth = referenceDate.getMonth();
  if (currentMonth === 11 && month === 0) {
    year += 1;
  }

  const date = new Date(Date.UTC(year, month, day));
  const parsedDate = date.toISOString().slice(0, 10);

  console.log("[weather-parser] Forecast date parsed", {
    rawDayLabel,
    parsedDate,
    year,
    month,
    day,
  });

  return parsedDate; // YYYY-MM-DD
}

export function parseTemperature(value: string) {
  const match = value.match(/-?\d+/);
  const parsed = match ? Number(match[0]) : null;

  if (parsed === null && value) {
    console.warn("[weather-parser] Temperature could not be parsed", { value });
  }

  return parsed;
}

export function parsePercent(value: string) {
  const match = value.match(/\d+/);
  const parsed = match ? Number(match[0]) : null;

  if (parsed === null && value) {
    console.warn("[weather-parser] Percent could not be parsed", { value });
  }

  return parsed;
}

export function parseWind(value: string) {
  // Example: "14 km/h NE"
  const speedMatch = value.match(/(\d+)\s*km\/h/i);
  const directionMatch = value.match(/km\/h\s+([A-ZÀ-ÿ]+)/i);

  const parsed = {
    windSpeedKmh: speedMatch ? Number(speedMatch[1]) : null,
    windDirection: directionMatch ? directionMatch[1] : null,
  };

  if (value && (parsed.windSpeedKmh === null || parsed.windDirection === null)) {
    console.warn("[weather-parser] Wind could not be fully parsed", {
      value,
      parsed,
    });
  }

  return parsed;
}

export function parseWindGust(value: string) {
  const match = value.match(/\d+/);
  const parsed = match ? Number(match[0]) : null;

  if (parsed === null && value) {
    console.warn("[weather-parser] Wind gust could not be parsed", { value });
  }

  return parsed;
}
