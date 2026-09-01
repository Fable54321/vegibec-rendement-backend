import express from "express";
import http2, { IncomingHttpHeaders } from "node:http2";

const router = express.Router();

const SMARTACCESS_DEVICES_URL = "https://sa.ke2.io/therm/devices";
const MAX_AGE_PATTERN = /^\d+[smhdw]$/i;

function getSmartAccessCookie(): string | null {
  const ke3Token = process.env.SMARTACCESS_KE3AT;
  const ke2Token = process.env.SMARTACCESS_KE2AT;

  if (!ke3Token || !ke2Token) return null;

  return [
    `KE3AT_sa.ke2.io=${ke3Token}`,
    `KE2AT_sa.ke2.io=${ke2Token}`,
  ].join("; ");
}

type SmartAccessResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

function requestSmartAccess(
  upstreamUrl: URL,
  cookie: string,
): Promise<SmartAccessResponse> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(upstreamUrl.origin);
    let settled = false;

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      client.close();
      reject(error);
    };

    client.once("error", finishWithError);

    const request = client.request({
      ":method": "POST",
      ":path": `${upstreamUrl.pathname}${upstreamUrl.search}`,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9,fr-CA;q=0.8,fr;q=0.7",
      "content-type": "application/json; charset=utf-8",
      cookie,
      origin: "https://sa.ke2.io",
      referer: "https://sa.ke2.io/n.html",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/152.0.0.0 Safari/537.36",
    });

    const chunks: Buffer[] = [];
    let responseHeaders: IncomingHttpHeaders = {};

    request.setEncoding("utf8");
    request.setTimeout(15_000, () => {
      request.close(http2.constants.NGHTTP2_CANCEL);
      const timeoutError = new Error("SmartAccess request timed out.");
      timeoutError.name = "TimeoutError";
      finishWithError(timeoutError);
    });

    request.on("response", (headers) => {
      responseHeaders = headers;
    });
    request.on("data", (chunk: string) => {
      chunks.push(Buffer.from(chunk));
    });
    request.once("error", finishWithError);
    request.once("end", () => {
      if (settled) return;
      settled = true;
      client.close();
      resolve({
        status: Number(responseHeaders[":status"] ?? 502),
        headers: responseHeaders,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    });

    request.end(JSON.stringify({ intersecting: [] }));
  });
}

/**
 * Proxies the SmartAccess device list without exposing its session cookies.
 * GET /temperatures/devices?max-age=168h&sp=0
 */
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

  const cookie = getSmartAccessCookie();
  if (!cookie) {
    return res.status(503).json({
      error:
        "SmartAccess is not configured. Set SMARTACCESS_KE3AT and SMARTACCESS_KE2AT.",
    });
  }

  const upstreamUrl = new URL(SMARTACCESS_DEVICES_URL);
  upstreamUrl.searchParams.set("max-age", maxAge);
  upstreamUrl.searchParams.set("sp", sp);

  try {
    const upstreamResponse = await requestSmartAccess(upstreamUrl, cookie);
    const responseBody = upstreamResponse.body;
    const contentType = String(upstreamResponse.headers["content-type"] ?? "");
    const upstreamContentLength = upstreamResponse.headers["content-length"]
      ? String(upstreamResponse.headers["content-length"])
      : null;

    if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
      console.error(
        `SmartAccess request failed with status ${upstreamResponse.status}`,
      );
      return res.status(502).json({
        error: "SmartAccess rejected the request.",
        upstreamStatus: upstreamResponse.status,
      });
    }

    res.set("Cache-Control", "no-store");

    if (!responseBody.trim()) {
      console.error("SmartAccess returned an empty successful response", {
        upstreamStatus: upstreamResponse.status,
        contentType: contentType || null,
        contentLength: upstreamContentLength,
      });
      return res.status(502).json({
        error: "SmartAccess returned an empty response.",
        upstreamStatus: upstreamResponse.status,
        upstreamContentType: contentType || null,
        upstreamContentLength,
      });
    }

    try {
      return res.json(JSON.parse(responseBody));
    } catch {
      if (contentType.includes("application/json")) {
        return res.status(502).json({
          error: "SmartAccess returned invalid JSON.",
        });
      }
    }

    return res.type(contentType || "text/plain").send(responseBody);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    console.error("SmartAccess request error:", error);
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? "SmartAccess request timed out."
        : "Could not reach SmartAccess.",
    });
  }
});

export default router;
