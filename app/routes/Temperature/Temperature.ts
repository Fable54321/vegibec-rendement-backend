import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

const fetchDailyWeatherReports = async () => {
    const url = "https://api.tomorrow.io/v4/weather/forecast?location=45.5152%2C%20-74.0622&timesteps=1d&units=metric&apikey=N2IlRRnzIhYdzyDqewpQWwgaOFyj0nES";
    const res = await fetch(url);
    return res.json();
}


router.get(
    "/",
    async (req, res) => {
        try {
            const result = await fetchDailyWeatherReports();

            res.status(200).json(result.rows);
        } catch (error) {
            console.error("Error fetching temperatures:", error);
            res.status(500).json({ error: "Failed to fetch temperatures" });
        }
    }
);


export default router;