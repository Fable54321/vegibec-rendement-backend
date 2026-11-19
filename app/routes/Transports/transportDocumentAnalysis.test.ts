import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTransportDocumentAnalysis,
  parseTransportDecimal,
  parseTransportQuantity,
} from "./transportDocumentAnalysis";

test("parses French decimal quantities as numeric totals", () => {
  assert.equal(parseTransportDecimal("50,00"), 50);
  assert.equal(parseTransportDecimal("50,0000"), 50);
  assert.equal(parseTransportDecimal("1,00"), 1);
});

test("preserves French thousands separated by spaces", () => {
  assert.equal(parseTransportDecimal("1 250"), 1250);
  assert.equal(parseTransportDecimal("187\u202f440"), 187440);
});

test("continues to support the previous multiplied quantity format", () => {
  assert.equal(parseTransportQuantity("3x80"), 240);
  assert.equal(parseTransportQuantity("3 × 80"), 240);
});

test("normalizes the new loading-slip quantity without multiplying by pallets", () => {
  const analysis = normalizeTransportDocumentAnalysis({
    pallets: "1,00",
    totalWeight: "1 250",
    rawText: "Qté à charger 50,00 Palette 1 Régulière",
    products: [
      {
        code: "805",
        lotNumber: "264720805",
        name: "Choux Bruxelles 25 lbs MED",
        quantityLabel: "50,00",
        quantity: "50,00",
        pallets: "1,00",
        palletType: "Régulière",
        unit: null,
      },
    ],
  });

  assert.equal(analysis.pallets, 1);
  assert.equal(analysis.totalWeight, 1250);
  assert.equal(analysis.products[0].quantityLabel, "50,00");
  assert.equal(analysis.products[0].quantity, 50);
  assert.equal(analysis.products[0].pallets, 1);
  assert.equal(analysis.products[0].palletType, "Régulière");
});

test("uses the recognized No Voyage value and falls back to the transcription", () => {
  assert.equal(
    normalizeTransportDocumentAnalysis({
      voyageNumber: "14066",
      rawText: "No Voyage\n99999",
      products: [],
    }).voyageNumber,
    "14066",
  );
  assert.equal(
    normalizeTransportDocumentAnalysis({
      voyageNumber: null,
      rawText: "Chargement voyage\nNo Voyage\n14067",
      products: [],
    }).voyageNumber,
    "14067",
  );
});
