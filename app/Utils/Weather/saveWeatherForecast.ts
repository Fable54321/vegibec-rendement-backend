// src/weather/saveWeatherForecast.ts

import { pool } from "../../db";
import {
  parseForecastDate,
  parseTemperature,
  parsePercent,
  parseWind,
  parseWindGust,
} from "./weatherParser";

type ScrapedWeatherPeriod = {
  timeOfDay: string;
  temperature: string;
  rainProbabilities: string;
  winds: string;
  windGusts: string;
};

type ScrapedWeatherDay = {
  day: string;
  periods: ScrapedWeatherPeriod[];
};

type ScrapedWeatherResult = {
  url: string;
  days: ScrapedWeatherDay[];
};

export async function saveWeatherForecast(scraped: ScrapedWeatherResult) {
  console.log("[weather-save] Connecting to database", {
    days: scraped.days.length,
    url: scraped.url,
    databaseUrlLoaded: Boolean(process.env.DATABASE_URL),
  });

  const client = await pool.connect();

  try {
    console.log("[weather-save] Database connection acquired");
    await client.query("BEGIN");
    console.log("[weather-save] Transaction started");

    for (const [dayIndex, day] of scraped.days.entries()) {
      const forecastDate = parseForecastDate(day.day);

      console.log("[weather-save] Saving forecast day", {
        dayIndex,
        rawDayLabel: day.day,
        forecastDate,
        periodCount: day.periods.length,
      });

      const dayResult = await client.query(
        `
        INSERT INTO weather.forecast_days (
          forecast_date,
          raw_day_label,
          source_url,
          scraped_at,
          updated_at
        )
        VALUES ($1, $2, $3, now(), now())
        ON CONFLICT (forecast_date)
        DO UPDATE SET
          raw_day_label = EXCLUDED.raw_day_label,
          source_url = EXCLUDED.source_url,
          scraped_at = now(),
          updated_at = now()
        RETURNING id
        `,
        [forecastDate, day.day, scraped.url]
      );

      const forecastDayId = dayResult.rows[0].id;

      console.log("[weather-save] Forecast day upserted", {
        dayIndex,
        forecastDate,
        forecastDayId,
        rowCount: dayResult.rowCount,
      });

      // Since you always expect 4 periods, this guarantees a clean replacement.
      const deleteResult = await client.query(
        `
        DELETE FROM weather.forecast_periods
        WHERE forecast_day_id = $1
        `,
        [forecastDayId]
      );

      console.log("[weather-save] Existing forecast periods deleted", {
        dayIndex,
        forecastDate,
        forecastDayId,
        deletedRows: deleteResult.rowCount,
      });

      for (const [periodIndex, period] of day.periods.entries()) {
        const { windSpeedKmh, windDirection } = parseWind(period.winds);
        const temperatureC = parseTemperature(period.temperature);
        const rainProbabilityPercent = parsePercent(period.rainProbabilities);
        const windGustKmh = parseWindGust(period.windGusts);

        console.log("[weather-save] Inserting forecast period", {
          dayIndex,
          periodIndex,
          forecastDate,
          forecastDayId,
          raw: period,
          parsed: {
            temperatureC,
            rainProbabilityPercent,
            windSpeedKmh,
            windDirection,
            windGustKmh,
          },
        });

        const periodResult = await client.query(
          `
          INSERT INTO weather.forecast_periods (
            forecast_day_id,
            time_of_day,
            temperature_c,
            rain_probability_percent,
            wind_speed_kmh,
            wind_direction,
            wind_gust_kmh,
            raw_temperature,
            raw_rain_probability,
            raw_winds,
            raw_wind_gusts,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11,
            now(), now()
          )
          `,
          [
            forecastDayId,
            period.timeOfDay,
            temperatureC,
            rainProbabilityPercent,
            windSpeedKmh,
            windDirection,
            windGustKmh,
            period.temperature,
            period.rainProbabilities,
            period.winds,
            period.windGusts,
          ]
        );

        console.log("[weather-save] Forecast period inserted", {
          dayIndex,
          periodIndex,
          forecastDate,
          forecastDayId,
          rowCount: periodResult.rowCount,
        });
      }
    }

    await client.query("COMMIT");
    console.log("[weather-save] Transaction committed", {
      days: scraped.days.length,
      periods: scraped.days.reduce((total, day) => total + day.periods.length, 0),
    });
  } catch (error) {
    console.error("[weather-save] Error while saving forecast, rolling back", {
      error: error instanceof Error ? error.message : error,
    });
    await client.query("ROLLBACK");
    console.log("[weather-save] Transaction rolled back");
    throw error;
  } finally {
    client.release();
    console.log("[weather-save] Database connection released");
  }
}
