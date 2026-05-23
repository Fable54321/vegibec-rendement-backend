import * as cheerio from "cheerio";

const DEFAULT_URL = "https://www.meteomedia.com/fr/ville/ca/quebec/oka/7-jours";
const DAYS_TO_SCRAPE = 7;
const PERIODS_PER_DAY = 4;

export async function scrapePage(url = DEFAULT_URL) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  const $ = cheerio.load(html);

  const getForecastColumnValues = (columnName: string) => {
    const datasetScript = $('script[type="application/ld+json"]')
      .toArray()
      .map((script) => $(script).text())
      .find((scriptText) => scriptText.includes('"csvw:columns"') && scriptText.includes(columnName));

    if (!datasetScript) {
      return [];
    }

    try {
      const dataset = JSON.parse(datasetScript);
      const columns = dataset?.mainEntity?.["csvw:tableSchema"]?.["csvw:columns"];
      const column = Array.isArray(columns)
        ? columns.find((item) => item?.["csvw:name"] === columnName)
        : undefined;

      return Array.isArray(column?.["csvw:cells"])
        ? column["csvw:cells"].map((cell) => String(cell?.["csvw:value"] ?? "").trim())
        : [];
    } catch {
      return [];
    }
  };

  const windSpeeds = getForecastColumnValues("windSpeed");
  const windDirections = getForecastColumnValues("windDirection");
  const windGusts = getForecastColumnValues("windGust");

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
        rainProbabilities: getRainProbabilities(rowIndex),
        winds: getWinds(rowIndex),
        windGusts: getWindGusts(rowIndex),
      };
    });

    return {
      day: getDay(dayIndex),
      periods,
    };
  });

  const forecastInfo = days
    .map(({ day, periods }) => {
      const periodLines = periods
        .map(
          ({ timeOfDay, temperature, rainProbabilities, winds, windGusts }) =>
            `  ${timeOfDay} ${temperature} P.D.P. ${rainProbabilities} Vents ${winds} Rafales ${windGusts}`
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
