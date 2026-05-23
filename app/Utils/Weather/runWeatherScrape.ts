import "dotenv/config";
// src/weather/runWeatherScrape.ts

import { scrapePage } from "../WebsiteScraper";
import { saveWeatherForecast } from "./saveWeatherForecast";

export async function runWeatherScrape() {
  const scraped = await scrapePage();

  await saveWeatherForecast(scraped);

  console.log(
    `Weather scrape saved successfully. Days saved: ${scraped.days.length}`
  );
}

if (require.main === module) {
  runWeatherScrape().catch((error) => {
    console.error("Weather scrape failed:", error);
    process.exitCode = 1;
  });
}