import express from "express";
import fetch from "node-fetch";

const router = express.Router();

interface CurrencyFreaksResponse {
  date: string;
  base: string;
  rates: {
    CAD: string;
  };
}

router.get("/fx-rate", async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({ error: "Missing date" });
  }

  try {
    const response = await fetch(
      `https://api.currencyfreaks.com/v2.0/rates/historical?apikey=${process.env.CURRENCYFREAKS_KEY}&date=${date}&base=USD&symbols=CAD`
    );

    const data = (await response.json()) as CurrencyFreaksResponse;

    const rate = parseFloat(data.rates.CAD);
    if (!rate) {
      return res.status(500).json({ error: "Invalid FX response" });
    }

    res.json({
      date,
      base: "USD",
      target: "CAD",
      rate,
    });
  } catch (err) {
    res.status(500).json({ error: "FX lookup failed" });
  }
});

export default router;
