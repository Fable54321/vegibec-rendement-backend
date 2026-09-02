import express from "express";
import type { Browser, Page } from "playwright";

// Render does not preserve Playwright's build-user cache at runtime. Keeping
// the browser alongside the package makes it part of the deployed application.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
const { chromium } = require("playwright") as typeof import("playwright");

const router = express.Router();

const SMARTACCESS_URL = "https://sa.ke2.io/n.html";
const MAX_AGE_PATTERN = /^\d+[smhdw]$/i;
const CACHE_TTL_MS = 30_000;
const SESSION_DATA_TTL_MS = 120_000;

let browser: Browser | null = null;
let page: Page | null = null;
let sessionPromise: Promise<Page> | null = null;

const cache = new Map<string, { expiresAt: number; data: unknown }>();
const pendingRequests = new Map<string, Promise<unknown>>();
const capturedDevices = new Map<
  string,
  { capturedAt: number; data: unknown }
>();

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function statusValue(status: JsonRecord, key: string): unknown {
  return asRecord(status[key])["::c"];
}

function parseTemperature(value: unknown) {
  const cleaned = cleanString(value);
  if (!cleaned) return null;

  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*°?([FC])$/i);
  if (!match) return null;

  return {
    value: Number(match[1]),
    unit: match[2].toUpperCase(),
  };
}

function parseRelay(value: unknown): boolean | null {
  const cleaned = cleanString(value)?.toLowerCase();
  if (cleaned === "relay on") return true;
  if (cleaned === "relay off") return false;
  return null;
}

function normalizeSmartAccessData(rawData: unknown) {
  const devices: JsonRecord[] = [];

  for (const [groupKey, rawDevices] of Object.entries(asRecord(rawData))) {
    const [, account = null, site = null] = groupKey.split("㊙");

    for (const [deviceKey, rawDevice] of Object.entries(asRecord(rawDevices))) {
      const device = asRecord(rawDevice);
      const status = asRecord(device.status);
      const firmware = asRecord(device.FW);
      const rawAlarms = statusValue(status, "AS");
      const alarms = (Array.isArray(rawAlarms) ? rawAlarms : [])
        .map(cleanString)
        .filter(
          (alarm): alarm is string =>
            alarm !== null && alarm.toLowerCase() !== "all clear",
        );

      devices.push({
        id: cleanString(device.mac) ?? deviceKey,
        name: cleanString(statusValue(status, "LO")),
        account,
        site,
        lastSeen:
          cleanString(status["::at"]) ?? cleanString(device.timestamp),
        error: cleanString(device.error),
        alarms,
        mode: cleanString(statusValue(status, "MDS")),
        temperatures: {
          tr: parseTemperature(statusValue(status, "TR")),
          tc: parseTemperature(statusValue(status, "TC")),
          x4: parseTemperature(statusValue(status, "X4")),
        },
        relays: {
          rc: parseRelay(statusValue(status, "RC")),
          rd: parseRelay(statusValue(status, "RD")),
          rf: parseRelay(statusValue(status, "RF")),
          rx: parseRelay(statusValue(status, "RX")),
        },
        firmware: {
          partNumber: cleanString(firmware.PartNumber),
          version: cleanString(firmware.Version),
          communicationType: cleanString(firmware.CommType),
        },
      });
    }
  }

  const timestamps = devices
    .map((device) => device.lastSeen)
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);

  return {
    updatedAt: timestamps.length
      ? new Date(Math.max(...timestamps)).toISOString()
      : new Date().toISOString(),
    count: devices.length,
    devices,
  };
}

function getCredentials() {
  const username = process.env.SMARTACCESS_USERNAME?.trim();
  const password = process.env.SMARTACCESS_PASSWORD;

  if (!username || !password) return null;
  return { username, password };
}

async function closeSession(): Promise<void> {
  const currentBrowser = browser;
  browser = null;
  page = null;
  sessionPromise = null;
  capturedDevices.clear();

  await currentBrowser?.close().catch(() => undefined);
}

async function createAuthenticatedPage(): Promise<Page> {
  const credentials = getCredentials();
  if (!credentials) {
    throw new Error(
      "SmartAccess is not configured. Set SMARTACCESS_USERNAME and SMARTACCESS_PASSWORD.",
    );
  }

  await closeSession();

  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/152.0.0.0 Safari/537.36",
  });
  const authenticatedPage = await context.newPage();

  authenticatedPage.on("response", async (response) => {
    try {
      const url = new URL(response.url());
      if (url.pathname !== "/therm/devices" || response.status() !== 200) return;

      const maxAge = url.searchParams.get("max-age");
      const sp = url.searchParams.get("sp");
      if (!maxAge || sp === null) return;

      const responseText = await response.text();
      if (!responseText.trim()) return;

      capturedDevices.set(`${maxAge}:${sp}`, {
        capturedAt: Date.now(),
        data: JSON.parse(responseText),
      });
    } catch {
      // SmartAccess issues several requests during startup; ignore incomplete
      // responses and retain the latest complete JSON response.
    }
  });

  await authenticatedPage.goto(SMARTACCESS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  await Promise.race([
    authenticatedPage.locator("#upEmailInput").waitFor({
      state: "visible",
      timeout: 30_000,
    }),
    authenticatedPage.waitForURL(
      (url) => url.hostname === "sa.ke2.io" && url.hash === "#home",
      { timeout: 30_000 },
    ),
  ]);

  if (await authenticatedPage.locator("#upEmailInput").isVisible()) {
    await authenticatedPage.locator("#upEmailInput").fill(credentials.username);
    await authenticatedPage.locator("#upPasswordInput").fill(credentials.password);

    await authenticatedPage.locator("#upSubmitBtn").click();
  }

  await authenticatedPage.waitForURL(
    (url) => url.hostname === "sa.ke2.io" && url.hash === "#home",
    { timeout: 60_000 },
  );

  const captureDeadline = Date.now() + 60_000;
  while (!capturedDevices.has("168h:0") && Date.now() < captureDeadline) {
    await authenticatedPage.waitForTimeout(250);
  }

  if (!capturedDevices.has("168h:0")) {
    throw new Error("SmartAccess loaded without usable device data.");
  }

  page = authenticatedPage;
  return authenticatedPage;
}

async function getAuthenticatedPage(): Promise<Page> {
  if (page && !page.isClosed()) return page;

  if (!sessionPromise) {
    sessionPromise = createAuthenticatedPage().finally(() => {
      sessionPromise = null;
    });
  }

  return sessionPromise;
}

async function fetchDevicesInBrowser(
  maxAge: string,
  sp: string,
): Promise<unknown> {
  await getAuthenticatedPage();

  const cacheKey = `${maxAge}:${sp}`;
  let captured = capturedDevices.get(cacheKey);

  if (
    !captured ||
    captured.capturedAt + SESSION_DATA_TTL_MS <= Date.now()
  ) {
    await closeSession();
    await getAuthenticatedPage();
    captured = capturedDevices.get(cacheKey);
  }

  if (!captured) {
    throw new Error(
      `SmartAccess did not load device data for max-age=${maxAge} and sp=${sp}.`,
    );
  }

  return captured.data;
}

async function fetchDevices(maxAge: string, sp: string): Promise<unknown> {
  try {
    return await fetchDevicesInBrowser(maxAge, sp);
  } catch (firstError) {
    console.warn("SmartAccess browser session failed; retrying login:", firstError);
    await closeSession();
    return fetchDevicesInBrowser(maxAge, sp);
  }
}

/** GET /temperatures/devices?max-age=168h&sp=0 */
router.get("/devices", async (req, res) => {
  const maxAge = String(req.query["max-age"] ?? "168h");
  const sp = String(req.query.sp ?? "0");

  if (!MAX_AGE_PATTERN.test(maxAge)) {
    return res.status(400).json({
      error: "Invalid max-age. Use a number followed by s, m, h, d, or w.",
    });
  }
  if (!/^\d+$/.test(sp)) {
    return res.status(400).json({ error: "Invalid sp value." });
  }
  if (!getCredentials()) {
    return res.status(503).json({
      error:
        "SmartAccess is not configured. Set SMARTACCESS_USERNAME and SMARTACCESS_PASSWORD.",
    });
  }

  const cacheKey = `${maxAge}:${sp}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.set("Cache-Control", "private, max-age=15");
    return res.json(cached.data);
  }

  try {
    // Serialize page evaluations because SmartAccess maintains state in the page.
    let pendingRequest = pendingRequests.get(cacheKey);
    if (!pendingRequest) {
      pendingRequest = fetchDevices(maxAge, sp).finally(() => {
        pendingRequests.delete(cacheKey);
      });
      pendingRequests.set(cacheKey, pendingRequest);
    }

    const data = normalizeSmartAccessData(await pendingRequest);
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, data });
    res.set("Cache-Control", "private, max-age=15");
    return res.json(data);
  } catch (error) {
    console.error("SmartAccess scraping error:", error);
    return res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : "Could not scrape SmartAccess.",
    });
  }
});

export default router;
