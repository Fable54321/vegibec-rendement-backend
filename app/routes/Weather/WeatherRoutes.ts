// app/Routes/weatherRoutes.ts

import express from "express";
import { pool } from "../../db"; 

const router = express.Router();

router.get("/forecast", async (req, res) => {
  try {
    const result = await pool.query(`
      WITH latest_forecast_days AS (
        SELECT *
        FROM weather.forecast_days
        ORDER BY forecast_date DESC
        LIMIT 14
      )
      SELECT
        fd.id AS forecast_day_id,
        fd.forecast_date,
        fd.raw_day_label,
        fd.source_url,
        fd.scraped_at,

        fp.id AS period_id,
        fp.time_of_day,
        fp.temperature_c,
        fp.rain_probability_percent,
        fp.wind_speed_kmh,
        fp.wind_direction,
        fp.wind_gust_kmh,
        fp.raw_temperature,
        fp.raw_rain_probability,
        fp.raw_winds,
        fp.raw_wind_gusts
      FROM latest_forecast_days fd
      LEFT JOIN weather.forecast_periods fp
        ON fp.forecast_day_id = fd.id
      ORDER BY
        fd.forecast_date ASC,
        CASE fp.time_of_day
          WHEN 'Matin' THEN 1
          WHEN 'Après-midi' THEN 2
          WHEN 'Soir' THEN 3
          WHEN 'Nuit' THEN 4
          ELSE 5
        END;
    `);

    const daysMap = new Map<number, any>();

    for (const row of result.rows) {
      if (!daysMap.has(row.forecast_day_id)) {
        daysMap.set(row.forecast_day_id, {
          id: row.forecast_day_id,
          forecastDate: row.forecast_date,
          rawDayLabel: row.raw_day_label,
          sourceUrl: row.source_url,
          scrapedAt: row.scraped_at,
          periods: [],
        });
      }

      if (row.period_id) {
        daysMap.get(row.forecast_day_id).periods.push({
          id: row.period_id,
          timeOfDay: row.time_of_day,
          temperatureC: row.temperature_c,
          rainProbabilityPercent: row.rain_probability_percent,
          windSpeedKmh: row.wind_speed_kmh,
          windDirection: row.wind_direction,
          windGustKmh: row.wind_gust_kmh,

          rawTemperature: row.raw_temperature,
          rawRainProbability: row.raw_rain_probability,
          rawWinds: row.raw_winds,
          rawWindGusts: row.raw_wind_gusts,
        });
      }
    }

    res.status(200).json({
      days: Array.from(daysMap.values()),
    });
  } catch (error) {
    console.error("Error fetching weather forecast:", error);
    res.status(500).json({ error: "Failed to fetch weather forecast" });
  }
});

export default router;
