import * as cheerio from "cheerio";

const DEFAULT_URL = "https://www.meteomedia.com/fr/ville/ca/quebec/gatineau/7-jours";

export async function scrapePage(url = DEFAULT_URL) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  const $ = cheerio.load(html);

  const getForecastRowTemperature = (rowIndex: number) =>
    $('[data-testid="forecast-module-row"]')
    .eq(rowIndex)
    .find('[data-testid="row-temperature"]')
    .first()
    .text()
    .trim();

  const afterNoonTemperature = getForecastRowTemperature(0);
  const eveningTemperature = getForecastRowTemperature(1);

  return {
    url,
    afterNoonTemperature,
    eveningTemperature,
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
