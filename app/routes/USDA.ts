// backend/src/routes/vegReports.ts
import express from "express";
import fetch from "node-fetch";
import { pool } from "../db";

const router = express.Router();

const auth = Buffer.from("LIm1Mr7tz2Nr0wjMkT+iNmpc1Cio+v6p:").toString(
  "base64"
);
const headers = { Authorization: `Basic ${auth}` };

// helper: get reports for a given market type
async function fetchMarketType(id: number) {
  const url = `https://marsapi.ams.usda.gov/services/v1.2/marketTypes/${id}`;
  const res = await fetch(url, { headers });
  return res.json();
}

// helper: get details for one slug id + date
async function fetchReport(id: number, date: string) {
  const url = `https://marsapi.ams.usda.gov/services/v1.2/reports/${id}/Report%20Details?q=report_date=${date}`;
  const res = await fetch(url, { headers });
  return res.json();
}

// route: /vegReports?date=MM/DD/YYYY
router.get("/", async (req, res) => {
  const date = req.query.date as string; // e.g. "09/12/2025"
  if (!date) {
    return res.status(400).json({ error: "Date is required (MM/DD/YYYY)" });
  }

  try {
    // step 1. get the market type
    const marketType = (await fetchMarketType(1036)) as Array<{ slug_name: string; slug_id: number }>; // Shipping Point

    // step 2. filter IDs that matter (FV120 = Benton Harbor veggies)
    const idsToFetch = marketType
      .filter((r: any) => r.slug_name.slice(3) === "FV120")
      .map((r: any) => r.slug_id);

    // step 3. fetch all reports in parallel
    const reports = await Promise.all(
      idsToFetch.map((id: number) => fetchReport(id, date))
    );

    // step 4. return combined data
    res.json({ date, reports });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vegetable reports" });
  }
});

router.get("/two-day-comparative", async (req, res) => {
  const { date } = req.query as {
    date?: string;
  };

  try {
    if (!date) {
      return res.status(400).json({ error: "Missing date" });
    }

    const dailyQuery = `
      WITH current_report AS (
        SELECT
          report_date,
          vegetable_id,
          organic,
          pkg,
          item_size,
          AVG(low_price::numeric)::float AS avg_low_price,
          AVG(high_price::numeric)::float AS avg_high_price,
          AVG(mostly_low_price::numeric)::float AS avg_mostly_low_price,
          AVG(mostly_high_price::numeric)::float AS avg_mostly_high_price
        FROM usda_reports
        WHERE report_date = $1
          AND vegetable_id IS NOT NULL
        GROUP BY report_date, vegetable_id, organic, pkg, item_size
      ),

      previous_report_date AS (
        SELECT MAX(report_date) AS report_date
        FROM usda_reports
        WHERE report_date < $1
          AND vegetable_id IS NOT NULL
          AND EXTRACT(ISODOW FROM report_date) < 6
      ),

      previous_report AS (
        SELECT
          report_date,
          vegetable_id,
          organic,
          pkg,
          item_size,
          AVG(low_price::numeric)::float AS previous_avg_low_price,
          AVG(high_price::numeric)::float AS previous_avg_high_price,
          AVG(mostly_low_price::numeric)::float AS previous_avg_mostly_low_price,
          AVG(mostly_high_price::numeric)::float AS previous_avg_mostly_high_price
        FROM usda_reports
        WHERE report_date = (SELECT report_date FROM previous_report_date)
          AND vegetable_id IS NOT NULL
        GROUP BY report_date, vegetable_id, organic, pkg, item_size
      )

      SELECT
        c.*,
        p.previous_avg_low_price,
        p.previous_avg_high_price,
        p.previous_avg_mostly_low_price,
        p.previous_avg_mostly_high_price
      FROM current_report c
      LEFT JOIN previous_report p
        ON p.vegetable_id = c.vegetable_id
       AND p.organic IS NOT DISTINCT FROM c.organic
       AND p.pkg IS NOT DISTINCT FROM c.pkg
       AND p.item_size IS NOT DISTINCT FROM c.item_size
    `;

    const result = await pool.query(dailyQuery, [date]);
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
