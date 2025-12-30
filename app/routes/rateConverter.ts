import express from "express";
import fetch from "node-fetch";

const router = express.Router();

// Simple in-memory cache
const fxCache = new Map<string, number>();

interface FreeCurrencyHistoricalResponse {
  data: {
    [date: string]: {
      CAD: number;
    };
  };
}

router.get("/fx-rate", async (req, res) => {
  const { date } = req.query as { date?: string };

  if (!date) {
    return res.status(400).json({ error: "Missing date" });
  }

  const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  if (!isValidDate) {
    return res
      .status(400)
      .json({ error: "Date invalide. Utilisez AAAA-MM-DD." });
  }

  const normalizedDate = new Date(`${date}T00:00:00Z`)
    .toISOString()
    .slice(0, 10);

  const cacheKey = `${normalizedDate}:USD:CAD`;

  // Check cache first
  if (fxCache.has(date)) {
    return res.json({
      date,
      base: "USD",
      target: "CAD",
      rate: fxCache.get(date),
      cached: true,
    });
  }

  try {
    const response = await fetch(
      `https://api.freecurrencyapi.com/v1/historical?apikey=${process.env.FREECURRENCY_API_KEY}&date=${date}&currencies=CAD`
    );

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: "freecurrencyAPI error" });
    }

    const data = (await response.json()) as FreeCurrencyHistoricalResponse;

    const rate = data?.data?.[date]?.CAD;

    if (typeof rate !== "number") {
      return res.status(500).json({ error: "Invalid FX response" });
    }

    // Store in cache
    fxCache.set(date, rate);

    res.json({
      date,
      base: "USD",
      target: "CAD",
      rate,
      cached: false,
    });
  } catch (err) {
    console.error("FX lookup failed:", err);
    res.status(500).json({ error: "FX lookup failed" });
  }
});

export default router;
