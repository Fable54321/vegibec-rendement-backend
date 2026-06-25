// backend/src/routes/vegReports.ts
import express from "express"
import fetch from "node-fetch"
import { pool } from "../db"

const router = express.Router()

const USDA_TOKEN = "LIm1Mr7tz2Nr0wjMkT+iNmpc1Cio+v6p"

const headers = {
  Authorization: `Basic ${Buffer.from(`${USDA_TOKEN}:`).toString("base64")}`,
  Accept: "application/json",
  "User-Agent": "vegibec-rendement-backend/1.0",
}

type MarketTypeReport = {
  slug_name: string
  slug_id: number
}

const USDA_BASE_URL = "https://marsapi.ams.usda.gov/services/v1.2"

async function fetchJsonSafely(url: string) {
  const res = await fetch(url, { headers })
  const contentType = res.headers.get("content-type") || ""
  const body = await res.text()

  if (!res.ok) {
    console.error("USDA request failed:", {
      status: res.status,
      statusText: res.statusText,
      contentType,
      url,
      bodyPreview: body.slice(0, 500),
    })

    return null
  }

  if (!body.trim()) {
    console.warn("USDA returned empty response:", {
      status: res.status,
      contentType,
      url,
    })

    return null
  }

  if (!contentType.toLowerCase().includes("application/json")) {
    console.error("USDA returned non-JSON response:", {
      status: res.status,
      contentType,
      url,
      bodyPreview: body.slice(0, 500),
    })

    return null
  }

  try {
    return JSON.parse(body)
  } catch (err) {
    console.error("USDA JSON parse failed:", {
      url,
      bodyPreview: body.slice(0, 500),
      error: err,
    })

    return null
  }
}

// helper: get reports for a given market type
async function fetchMarketType(id: number) {
  const url = `${USDA_BASE_URL}/marketTypes/${id}`
  return fetchJsonSafely(url)
}

// helper: get details for one slug id + date
async function fetchReport(id: number, date: string) {
  const query = `report_date=${date}`

  const url =
    `${USDA_BASE_URL}/reports/${id}/Report%20Details` +
    `?q=${encodeURIComponent(query)}`

  return fetchJsonSafely(url)
}

// route: /vegReports?date=MM/DD/YYYY
router.get("/", async (req, res) => {
  const date = req.query.date as string | undefined

  if (!date) {
    return res.status(400).json({
      error: "Date is required (MM/DD/YYYY)",
    })
  }

  try {
    const marketType = await fetchMarketType(1036)

    if (!Array.isArray(marketType)) {
      return res.status(502).json({
        error: "USDA market type response was invalid",
        date,
        reports: [],
      })
    }

    const idsToFetch = (marketType as MarketTypeReport[])
      .filter((r) => r.slug_name?.slice(3) === "FV120")
      .map((r) => r.slug_id)
      .filter((id) => Number.isInteger(id))

    if (!idsToFetch.length) {
      return res.json({
        date,
        reports: [],
      })
    }

    console.log("USDA FV120 slug IDs to fetch:", idsToFetch)

    const settledReports = await Promise.allSettled(
      idsToFetch.map((id) => fetchReport(id, date)),
    )

    const reports = settledReports
      .map((result, index) => {
        const slugId = idsToFetch[index]

        if (result.status === "rejected") {
          console.error("USDA fetch crashed:", {
            slugId,
            reason: result.reason,
          })

          return null
        }

        if (!result.value) {
          console.warn("USDA fetch returned no usable JSON:", {
            slugId,
            date,
          })

          return null
        }

        return result.value
      })
      .filter(Boolean)

    return res.json({
      date,
      reports,
    })
  } catch (err) {
    console.error("USDA vegReports route error:", err)

    return res.status(500).json({
      error: "Failed to fetch vegetable reports",
      date,
      reports: [],
    })
  }
})

router.get("/two-day-comparative", async (req, res) => {
  const { date } = req.query as {
    date?: string
  }

  try {
    if (!date) {
      return res.status(400).json({ error: "Missing date" })
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
    `

    const result = await pool.query(dailyQuery, [date])
    return res.json(result.rows)
  } catch (err) {
    console.error("two-day-comparative route error:", err)
    return res.status(500).json({ error: "Server error" })
  }
})

export default router