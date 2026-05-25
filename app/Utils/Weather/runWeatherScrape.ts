import "dotenv/config";
import { scrapePage } from "./scrapePage";
import { saveWeatherForecast } from "./saveWeatherForecast";

export async function runWeatherScrape() {
  console.log("=== WEATHER SCRAPE START ===");
  console.log("Started at:", new Date().toISOString());
  console.log("DATABASE_URL loaded?", Boolean(process.env.DATABASE_URL));

  const scraped = await scrapePage();

  console.log("Scrape completed.");
  console.log("URL:", scraped.url);
  console.log("Days scraped:", scraped.days.length);
  console.log(
    "Day labels:",
    scraped.days.map((d) => d.day).join(", ")
  );

  await saveWeatherForecast(scraped);

  console.log("DB save completed.");
  console.log("Finished at:", new Date().toISOString());
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