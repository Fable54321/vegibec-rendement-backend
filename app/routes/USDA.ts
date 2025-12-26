// backend/src/routes/vegReports.ts
import express from "express";
import fetch from "node-fetch";

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

export default router;
