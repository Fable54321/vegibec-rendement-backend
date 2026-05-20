import { Router } from "express";

const router = Router();

const fetchDailyWeatherReports = async () => {
    const url = "https://api.tomorrow.io/v4/weather/forecast?location=45.5152%2C%20-74.0622&timesteps=1d&units=metric&apikey=N2IlRRnzIhYdzyDqewpQWwgaOFyj0nES";
    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`Tomorrow.io request failed: ${res.status} ${res.statusText}`);
    }

    return res.json();
}


router.get(
    "/",
    async (req, res) => {
        try {
            const result = await fetchDailyWeatherReports();

            res.status(200).json(result);
        } catch (error) {
            console.error("Error fetching temperatures:", error);
            res.status(500).json({ error: "Failed to fetch temperatures" });
        }
    }
);


if (require.main === module) {
    fetchDailyWeatherReports()
        .then((result) => {
            console.log(JSON.stringify(result, null, 2));
        })
        .catch((error) => {
            console.error("Error fetching temperatures:", error);
            process.exit(1);
        });
}

export default router;
