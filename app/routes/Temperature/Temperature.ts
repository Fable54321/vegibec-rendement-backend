import dotenv from "dotenv";
dotenv.config();
import { Router } from "express";
import { pool } from "../../db";

const router = Router();

type TomorrowDailyWeatherValues = {
    temperatureMin: number | null;
    temperatureMax: number | null;
    temperatureAvg: number | null;
    precipitationProbabilityAvg: number | null;
    windSpeedAvg: number | null;
    windGustAvg: number | null;
    windGustMax: number | null;
    windSpeedMax: number | null;
    windSpeedMin: number | null;
    windGustMin: number | null;
    precipitationProbabilityMin: number | null;
    precipitationProbabilityMax: number | null;
};

type TomorrowDailyWeatherReport = {
    time: string;
    values: TomorrowDailyWeatherValues;
};

type TomorrowWeatherResponse = {
    timelines?: {
        daily?: TomorrowDailyWeatherReport[];
    };
};

const fetchDailyWeatherReports = async () => {
    const url = "https://api.tomorrow.io/v4/weather/forecast?location=45.5152%2C%20-74.0622&timesteps=1d&units=metric&apikey=N2IlRRnzIhYdzyDqewpQWwgaOFyj0nES";
    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`Tomorrow.io request failed: ${res.status} ${res.statusText}`);
    }

    return res.json() as Promise<TomorrowWeatherResponse>;
}

const fetchStoredDailyWeatherReports = async () => {
    const result = await pool.query(
        `
            SELECT *
            FROM foreign_workers_schedule.tempurature_reports
            WHERE date >= CURRENT_DATE
            ORDER BY date ASC
        `,
    );

    return result.rows;
};

const saveDailyWeatherReports = async (reports: TomorrowDailyWeatherReport[]) => {
    if (reports.length === 0) {
        return [];
    }

    const values = reports.flatMap((report) => {
        const weatherValues = report.values;

        return [
            report.time,
            weatherValues.temperatureMin,
            weatherValues.temperatureMax,
            weatherValues.temperatureAvg,
            weatherValues.precipitationProbabilityAvg,
            weatherValues.windSpeedAvg,
            weatherValues.windGustAvg,
            weatherValues.windGustMax,
            weatherValues.windSpeedMax,
            weatherValues.windSpeedMin,
            weatherValues.windGustMin,
            weatherValues.precipitationProbabilityMin,
            weatherValues.precipitationProbabilityMax,
        ];
    });

    const columnsPerReport = 13;
    const placeholders = reports
        .map((_, reportIndex) => {
            const offset = reportIndex * columnsPerReport;
            const rowPlaceholders = Array.from(
                { length: columnsPerReport },
                (_, columnIndex) => `$${offset + columnIndex + 1}`,
            );

            return `(${rowPlaceholders.join(", ")})`;
        })
        .join(", ");

    const result = await pool.query(
        `
            INSERT INTO foreign_workers_schedule.tempurature_reports (
                date,
                temperature_min,
                temperature_max,
                temperature_avg,
                precipitation_probability_avg,
                wind_speed_avg,
                wind_gust_avg,
                wind_gust_max,
                wind_speed_max,
                wind_speed_min,
                wind_gust_min,
                precipitation_probability_min,
                precipitation_probability_max
            )
            VALUES ${placeholders}
            RETURNING *
        `,
        values,
    );

    return result.rows;
};

const getDailyWeatherReports = async () => {
    const storedReports = await fetchStoredDailyWeatherReports();

    if (storedReports.length > 0) {
        return {
            source: "db",
            reports: storedReports,
        };
    }

    const weatherReport = await fetchDailyWeatherReports();
    const dailyReports = weatherReport.timelines?.daily ?? [];
    const insertedReports = await saveDailyWeatherReports(dailyReports);

    return {
        source: "api",
        weatherReport,
        reports: insertedReports,
    };
};


router.get(
    "/",
    async (req, res) => {
        try {
            const result = await getDailyWeatherReports();

            res.status(200).json(result);
        } catch (error) {
            console.error("Error fetching temperatures:", error);
            res.status(500).json({ error: "Failed to fetch temperatures" });
        }
    }
);


if (require.main === module) {
    getDailyWeatherReports()
        .then((result) => {
            console.log(JSON.stringify(result, null, 2));
        })
        .catch((error) => {
            console.error("Error fetching temperatures:", error);
            process.exit(1);
        })
        .finally(async () => {
            await pool.end();
        });
}

export default router;
