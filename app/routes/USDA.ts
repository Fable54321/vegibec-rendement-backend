// backend/src/routes/vegReports.ts
import express from "express"
import fetch from "node-fetch"
import { pool } from "../db"

const router = express.Router()

const USDA_TOKEN =
  process.env.USDA_TOKEN?.trim() || "LIm1Mr7tz2Nr0wjMkT+iNmpc1Cio+v6p"
const USDA_MARKET_TYPE_ID = 1036
const USDA_FV120_REPORT_CODE = "FV120"
const USDA_SLUG_ID_CACHE_MS = 1000 * 60 * 60 * 12
const USDA_REQUEST_RETRY_DELAYS_MS = [500, 1500]

const headers = {
  Authorization: `Basic ${Buffer.from(`${USDA_TOKEN}:`).toString("base64")}`,
  Accept: "application/json",
  "User-Agent": "vegibec-rendement-backend/1.0",
}

type MarketTypeReport = {
  slug_name?: string
  slug_id?: number
}

const USDA_BASE_URL = "https://marsapi.ams.usda.gov/services/v1.2"

let cachedFv120SlugIds:
  | {
      ids: number[]
      expiresAt: number
    }
  | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchJsonSafely(url: string) {
  for (let attempt = 0; attempt <= USDA_REQUEST_RETRY_DELAYS_MS.length; attempt++) {
    try {
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
          attempt: attempt + 1,
        })

        if (res.status >= 500 && attempt < USDA_REQUEST_RETRY_DELAYS_MS.length) {
          await sleep(USDA_REQUEST_RETRY_DELAYS_MS[attempt])
          continue
        }

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
          attempt: attempt + 1,
        })

        if (attempt < USDA_REQUEST_RETRY_DELAYS_MS.length) {
          await sleep(USDA_REQUEST_RETRY_DELAYS_MS[attempt])
          continue
        }

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
    } catch (err) {
      console.error("USDA request crashed:", {
        url,
        attempt: attempt + 1,
        error: err,
      })

      if (attempt < USDA_REQUEST_RETRY_DELAYS_MS.length) {
        await sleep(USDA_REQUEST_RETRY_DELAYS_MS[attempt])
        continue
      }

      return null
    }
  }

  return null
}

// helper: get reports for a given market type
async function fetchMarketType(id: number) {
  const url = `${USDA_BASE_URL}/marketTypes/${id}`
  return fetchJsonSafely(url)
}

// fallback helper: get every report definition if marketTypes is unavailable
async function fetchReports() {
  const url = `${USDA_BASE_URL}/reports`
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

function parseFv120SlugIds(reports: unknown) {
  if (!Array.isArray(reports)) return []

  return (reports as MarketTypeReport[])
    .filter((report) => {
      const slugName =
        typeof report.slug_name === "string" ? report.slug_name.trim() : ""

      return (
        slugName === USDA_FV120_REPORT_CODE ||
        slugName.endsWith(USDA_FV120_REPORT_CODE)
      )
    })
    .map((report) => Number(report.slug_id))
    .filter((id) => Number.isInteger(id) && id > 0)
}

function getConfiguredFv120SlugIds() {
  return (process.env.USDA_FV120_SLUG_IDS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)
}

function cacheFv120SlugIds(ids: number[]) {
  cachedFv120SlugIds = {
    ids,
    expiresAt: Date.now() + USDA_SLUG_ID_CACHE_MS,
  }

  return ids
}

async function getFv120SlugIds() {
  const configuredIds = getConfiguredFv120SlugIds()

  if (configuredIds.length > 0) {
    return configuredIds
  }

  if (cachedFv120SlugIds && cachedFv120SlugIds.expiresAt > Date.now()) {
    return cachedFv120SlugIds.ids
  }

  const marketType = await fetchMarketType(USDA_MARKET_TYPE_ID)
  const marketTypeIds = parseFv120SlugIds(marketType)

  if (marketTypeIds.length > 0) {
    return cacheFv120SlugIds(marketTypeIds)
  }

  const reports = await fetchReports()
  const reportIds = parseFv120SlugIds(reports)

  if (reportIds.length > 0) {
    return cacheFv120SlugIds(reportIds)
  }

  if (cachedFv120SlugIds?.ids.length) {
    console.warn("Using expired USDA FV120 slug ID cache")
    return cachedFv120SlugIds.ids
  }

  return []
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
    const idsToFetch = await getFv120SlugIds()

    if (!idsToFetch.length) {
      return res.status(502).json({
        error:
          "USDA report list is unavailable and no FV120 slug IDs are configured",
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
