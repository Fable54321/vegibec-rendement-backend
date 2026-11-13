import assert from "node:assert/strict";
import test from "node:test";
import { resolveTransportDocumentDate } from "./transportDocumentDate";

test("keeps a valid structured loading date", () => {
  assert.equal(resolveTransportDocumentDate("2026-11-13", ""), "2026-11-13");
});

test("extracts the date below Shipping / Chargé", () => {
  const rawText = `
    Chargement voyage No Voyage 11837
    Shipping / Chargé   Sold by / Vendeur   Carrier / Transporteur
    2026-11-13          Claudia Moreno       PICK UP
  `;

  assert.equal(resolveTransportDocumentDate(null, rawText), "2026-11-13");
});

test("corrects common OCR characters and date separators", () => {
  assert.equal(
    resolveTransportDocumentDate(null, "Shipping / Charge 2O26/11/13"),
    "2026-11-13",
  );
});

test("rejects impossible and unrelated dates", () => {
  assert.equal(
    resolveTransportDocumentDate(null, "Shipping / Chargé 2026-02-31"),
    null,
  );
  assert.equal(
    resolveTransportDocumentDate(null, "Ordered 2026-11-13\nChargement #: 1"),
    null,
  );
});
