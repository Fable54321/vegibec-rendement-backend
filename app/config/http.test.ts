import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { configureHttp } from "./http";

function createTestApp() {
  const app = express();
  configureHttp(app);
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  return app;
}

test("allows the production portal origin", async () => {
  const response = await request(createTestApp())
    .get("/probe")
    .set("Origin", "https://vegibec-portail.com");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers["access-control-allow-origin"],
    "https://vegibec-portail.com",
  );
});

test("allows requests without an Origin header", async () => {
  const response = await request(createTestApp()).get("/probe");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test("returns 403 and records useful details for a blocked origin", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values);

  try {
    const response = await request(createTestApp())
      .get("/probe?source=preview")
      .set("Origin", "https://unexpected.example")
      .set("User-Agent", "cors-test");

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: "Origin not allowed" });
    assert.deepEqual(warnings, [
      [
        "[CORS] Blocked request",
        {
          origin: "https://unexpected.example",
          method: "GET",
          path: "/probe",
          userAgent: "cors-test",
        },
      ],
    ]);
  } finally {
    console.warn = originalWarn;
  }
});
