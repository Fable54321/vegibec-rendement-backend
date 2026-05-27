import * as cheerio from "cheerio";

const DEFAULT_URL = "https://www.meteomedia.com/fr/ville/ca/quebec/oka/7-jours";
const DAYS_TO_SCRAPE = 8;
const PERIODS_PER_DAY = 4;

export async function scrapePage(url = DEFAULT_URL) {
  const startedAt = Date.now();
  console.log("[weather-scraper] Fetch started", {
    url,
    startedAt: new Date(startedAt).toISOString(),
  });

  const response = await fetch(url);

  console.log("[weather-scraper] Fetch response received", {
    url,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  console.log("[weather-scraper] HTML downloaded", {
    url,
    bytes: Buffer.byteLength(html, "utf8"),
    characters: html.length,
    elapsedMs: Date.now() - startedAt,
  });

  const $ = cheerio.load(html);
  const datasetScripts = $('script[type="application/ld+json"]').toArray();
  const headings = $('[data-testid="period-section-heading"]');
  const rows = $('[data-testid="forecast-module-row"]');

  console.log("[weather-scraper] DOM selector counts", {
    datasetScripts: datasetScripts.length,
    periodSectionHeadings: headings.length,
    forecastRows: rows.length,
    expectedDays: DAYS_TO_SCRAPE,
    expectedRows: DAYS_TO_SCRAPE * PERIODS_PER_DAY,
  });

  const getForecastColumnValues = (columnName: string) => {
    const datasetScript = datasetScripts
      .map((script) => $(script).text())
      .find((scriptText) => scriptText.includes('"csvw:columns"') && scriptText.includes(columnName));

    if (!datasetScript) {
      console.warn("[weather-scraper] JSON-LD forecast column script not found", {
        columnName,
        datasetScripts: datasetScripts.length,
      });
      return [];
    }

    try {
      const dataset = JSON.parse(datasetScript);
      const columns = dataset?.mainEntity?.["csvw:tableSchema"]?.["csvw:columns"];
      const column = Array.isArray(columns)
        ? columns.find((item) => item?.["csvw:name"] === columnName)
        : undefined;

      const values = Array.isArray(column?.["csvw:cells"])
        ? column["csvw:cells"].map((cell) => String(cell?.["csvw:value"] ?? "").trim())
        : [];

      console.log("[weather-scraper] JSON-LD forecast column extracted", {
        columnName,
        valueCount: values.length,
        sample: values.slice(0, 4),
      });

      return values;
    } catch (error) {
      console.warn("[weather-scraper] Failed to parse JSON-LD forecast column", {
        columnName,
        error: error instanceof Error ? error.message : error,
      });
      return [];
    }
  };

  const windSpeeds = getForecastColumnValues("windSpeed");
  const windDirections = getForecastColumnValues("windDirection");
  const windGusts = getForecastColumnValues("windGust");
  const weatherComments = getForecastColumnValues("condition");

  const getDay = (dayIndex: number) =>
    $('[data-testid="period-section-heading"]')
      .eq(dayIndex)
      .find("h2")
      .first()
      .text()
      .trim();

  const getTimeOfDay = (rowIndex: number) =>
    $('[data-testid="forecast-module-row"]')
      .eq(rowIndex)
      .find('[data-testid="row-date-or-time"]')
      .first()
      .text()
      .trim();

  const getForecastRowTemperature = (rowIndex: number) =>
    $('[data-testid="forecast-module-row"]')
      .eq(rowIndex)
      .find('[data-testid="row-temperature"]')
      .first()
      .text()
      .trim();

  const getTemperatureFelt = (rowIndex: number) => {
    const feelsLikeText = $('[data-testid="forecast-module-row"]')
      .eq(rowIndex)
      .find('[data-testid="row-feels-like"]')
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    const temperatureMatches = feelsLikeText.match(/-?\d+/g);
    return temperatureMatches?.at(-1) ?? "";
  };

  const getWeatherComment = (rowIndex: number) => {
    const forecastColumnComment = weatherComments[rowIndex];

    if (forecastColumnComment) {
      return forecastColumnComment;
    }

    return $('[data-testid="forecast-module-row"]')
      .eq(rowIndex)
      .find('[data-testid="expanded-row-weather-text"]')
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
  };

  const getRainProbabilities = (rowIndex: number) => {
    const row = $('[data-testid="forecast-module-row"]').eq(rowIndex);
    const expandedRainProbability = row
      .find('[data-testid="precip-values"]')
      .first()
      .text()
      .replace(/\s+/g, "")
      .trim();

    if (expandedRainProbability) {
      return expandedRainProbability;
    }

    const collapsedRainProbability = row
      .find('[data-testid="collapsed-row-pop-info"]')
      .first()
      .text()
      .replace(/\s+/g, "")
      .trim()
      .match(/\d+%/);

    return collapsedRainProbability?.[0] ?? "";
  };

  const getWinds = (rowIndex: number) =>
    [windSpeeds[rowIndex], windDirections[rowIndex]].filter(Boolean).join(" ");

  const getWindGusts = (rowIndex: number) => windGusts[rowIndex] ?? "";

  const days = Array.from({ length: DAYS_TO_SCRAPE }, (_, dayIndex) => {
    const firstRowIndexForDay = dayIndex * PERIODS_PER_DAY;

    const periods = Array.from({ length: PERIODS_PER_DAY }, (_, periodIndex) => {
      const rowIndex = firstRowIndexForDay + periodIndex;

      return {
        timeOfDay: getTimeOfDay(rowIndex),
        temperature: getForecastRowTemperature(rowIndex),
        temperatureFelt: getTemperatureFelt(rowIndex),
        rainProbabilities: getRainProbabilities(rowIndex),
        winds: getWinds(rowIndex),
        windGusts: getWindGusts(rowIndex),
        weatherComment: getWeatherComment(rowIndex),
      };
    });

    return {
      day: getDay(dayIndex),
      periods,
    };
  });

  days.forEach((day, dayIndex) => {
    const missingFields = day.periods.flatMap((period, periodIndex) => {
      const fields = [
        ["timeOfDay", period.timeOfDay],
        ["temperature", period.temperature],
        ["temperatureFelt", period.temperatureFelt],
        ["rainProbabilities", period.rainProbabilities],
        ["winds", period.winds],
        ["windGusts", period.windGusts],
        ["weatherComment", period.weatherComment],
      ];

      return fields
        .filter(([, value]) => !value)
        .map(([field]) => `period ${periodIndex + 1} ${field}`);
    });

    const logPayload = {
      dayIndex,
      day: day.day,
      periodCount: day.periods.length,
      periods: day.periods,
      missingFields,
    };

    if (!day.day || missingFields.length > 0) {
      console.warn("[weather-scraper] Parsed day has missing values", logPayload);
    } else {
      console.log("[weather-scraper] Parsed day summary", logPayload);
    }
  });

  const forecastInfo = days
    .map(({ day, periods }) => {
      const periodLines = periods
        .map(
          ({ timeOfDay, temperature, temperatureFelt, rainProbabilities, winds, windGusts, weatherComment }) =>
            `  ${timeOfDay} ${temperature} T. ress ${temperatureFelt} P.D.P. ${rainProbabilities} Vents ${winds} Rafales ${windGusts} ${weatherComment}`
        )
        .join("\n");

      return `  ${day}\n${periodLines}`;
    })
    .join("\n\n");

  return {
    url,
    days,
    forecastInfo,
  };
}

if (require.main === module) {
  const url = process.argv[2] ?? DEFAULT_URL;

  scrapePage(url)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
