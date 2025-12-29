import express from "express";
import fetch from "node-fetch";

const router = express.Router();

// Simple in-memory cache
const fxCache = new Map<string, number>();

interface CurrencyFreaksResponse {
  date: string;
  base: string;
  rates: {
    CAD: string;
  };
}

router.get("/fx-rate", async (req, res) => {
  const { date } = req.query as { date?: string };

  if (!date) {
    return res.status(400).json({ error: "Missing date" });
  }

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
      `https://api.currencyfreaks.com/v2.0/rates/historical?apikey=${process.env.CURRENCYFREAKS_KEY}&date=${date}&base=USD&symbols=CAD`
    );

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: "CurrencyFreaks API error" });
    }

    const data = (await response.json()) as CurrencyFreaksResponse;

    const rate = parseFloat(data.rates.CAD);
    if (Number.isNaN(rate)) {
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
