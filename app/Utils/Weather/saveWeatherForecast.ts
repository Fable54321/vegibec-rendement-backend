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
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const day of scraped.days) {
      const forecastDate = parseForecastDate(day.day);

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

      // Since you always expect 4 periods, this guarantees a clean replacement.
      await client.query(
        `
        DELETE FROM weather.forecast_periods
        WHERE forecast_day_id = $1
        `,
        [forecastDayId]
      );

      for (const period of day.periods) {
        const { windSpeedKmh, windDirection } = parseWind(period.winds);

        await client.query(
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
            parseTemperature(period.temperature),
            parsePercent(period.rainProbabilities),
            windSpeedKmh,
            windDirection,
            parseWindGust(period.windGusts),
            period.temperature,
            period.rainProbabilities,
            period.winds,
            period.windGusts,
          ]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}