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
const USDA_REQUEST_TIMEOUT_MS = 15000
const USDA_API_BASE_URLS = [
  process.env.USDA_API_BASE_URL?.trim(),
  "https://marsapi.ams.usda.gov/services/v3.0",
  "https://marsapi.ams.usda.gov/services/v1.2",
].filter(Boolean) as string[]
const USDA_PUBLIC_BASE_URL = "https://marsapi.ams.usda.gov/services/v1.1/public"

const headers = {
  Authorization: `Basic ${Buffer.from(`${USDA_TOKEN}:`).toString("base64")}`,
  Accept: "application/json",
  "User-Agent": "vegibec-rendement-backend/1.0",
}

type MarketTypeReport = {
  slug_name?: string
  slug_id?: number | string
}

let cachedFv120SlugIds:
  | {
      ids: number[]
      expiresAt: number
    }
  | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchJsonSafely(url: string) {
  for (let attempt = 0; attempt <= USDA_REQUEST_RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), USDA_REQUEST_TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        headers,
        signal: controller.signal,
      })
      const contentType = res.headers.get("content-type") || ""
      const body = await res.text()
      clearTimeout(timeout)

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
      clearTimeout(timeout)

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

async function fetchTextSafely(url: string) {
  for (let attempt = 0; attempt <= USDA_REQUEST_RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), USDA_REQUEST_TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        headers,
        signal: controller.signal,
      })
      const contentType = res.headers.get("content-type") || ""
      const body = await res.text()
      clearTimeout(timeout)

      if (!res.ok) {
        console.error("USDA public request failed:", {
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
        return null
      }

      return body
    } catch (err) {
      clearTimeout(timeout)

      console.error("USDA public request crashed:", {
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
  for (const baseUrl of USDA_API_BASE_URLS) {
    const url = `${baseUrl}/marketTypes/${id}`
    const marketType = await fetchJsonSafely(url)

    if (marketType) return marketType
  }

  return null
}

// fallback helper: get every report definition if marketTypes is unavailable
async function fetchReports() {
  for (const baseUrl of USDA_API_BASE_URLS) {
    const url = `${baseUrl}/reports`
    const reports = await fetchJsonSafely(url)

    if (reports) return reports
  }

  return null
}

// helper: get details for one slug id + date
async function fetchReport(id: number, date: string) {
  const sectionNames = ["Report%20Details", "Details"]
  const dateFilters = [`report_begin_date=${date}`, `report_date=${date}`]

  for (const baseUrl of USDA_API_BASE_URLS) {
    for (const sectionName of sectionNames) {
      for (const dateFilter of dateFilters) {
        const url =
          `${baseUrl}/reports/${id}/${sectionName}` +
          `?q=${encodeURIComponent(dateFilter)}`
        const report = await fetchJsonSafely(url)

        if (report) return report
      }
    }
  }

  return null
}

function parseFv120SlugIds(reports: unknown) {
  const reportRows = Array.isArray(reports)
    ? reports
    : reports &&
        typeof reports === "object" &&
        Array.isArray((reports as { results?: unknown }).results)
      ? (reports as { results: unknown[] }).results
      : []

  return (reportRows as MarketTypeReport[])
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

function parseFv120SlugIdsFromPublishedReports(text: string) {
  const ids = new Set<number>()
  const lines = text.split(/\r?\n/)

  for (const line of lines) {
    if (!line.includes(USDA_FV120_REPORT_CODE)) continue

    const slugIdMatch =
      line.match(/slug[_\s-]*id\D+(\d+)/i) ||
      line.match(/\b(\d{3,6})\b.*FV120/i) ||
      line.match(/FV120.*\b(\d{3,6})\b/i)

    if (!slugIdMatch) continue

    const slugId = Number(slugIdMatch[1])

    if (Number.isInteger(slugId) && slugId > 0) {
      ids.add(slugId)
    }
  }

  return Array.from(ids)
}

async function fetchPublishedReportSlugIds() {
  const text = await fetchTextSafely(`${USDA_PUBLIC_BASE_URL}/listPublishedReports/30`)

  return text ? parseFv120SlugIdsFromPublishedReports(text) : []
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

  const publishedReportIds = await fetchPublishedReportSlugIds()

  if (publishedReportIds.length > 0) {
    return cacheFv120SlugIds(publishedReportIds)
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
