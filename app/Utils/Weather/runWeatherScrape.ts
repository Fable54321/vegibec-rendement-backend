import "dotenv/config";
import { scrapePage } from "../WebsiteScraper";
import { saveWeatherForecast } from "./saveWeatherForecast";

export async function runWeatherScrape() {
  const runId = `weather-${Date.now()}`;
  const startedAt = Date.now();

  console.log("=== WEATHER SCRAPE START ===");
  console.log("[weather-run] Runtime context", {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    nodeEnv: process.env.NODE_ENV,
    nodeVersion: process.version,
    platform: process.platform,
    cwd: process.cwd(),
    argv: process.argv,
    databaseUrlLoaded: Boolean(process.env.DATABASE_URL),
  });

  console.log("[weather-run] Starting page scrape", { runId });
  const scraped = await scrapePage();

  console.log("[weather-run] Scrape completed", {
    runId,
    url: scraped.url,
    daysScraped: scraped.days.length,
    periodCounts: scraped.days.map((day) => day.periods.length),
    dayLabels: scraped.days.map((day) => day.day),
    emptyDayLabels: scraped.days.filter((day) => !day.day).length,
    emptyPeriodFields: scraped.days.reduce(
      (total, day) =>
        total +
        day.periods.reduce(
          (dayTotal, period) =>
            dayTotal +
            Object.values(period).filter((value) => !value).length,
          0
        ),
      0
    ),
  });

  console.log("[weather-run] Starting DB save", { runId });
  await saveWeatherForecast(scraped);

  console.log("[weather-run] DB save completed", { runId });
  console.log("[weather-run] Finished", {
    runId,
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
  });
  console.log("=== WEATHER SCRAPE END ===");
}

if (require.main === module) {
  runWeatherScrape()
    .then(() => {
      console.log("Weather scrape process exited successfully.");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Weather scrape failed:", error);
      process.exit(1);
    });
}
