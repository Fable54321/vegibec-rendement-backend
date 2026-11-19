import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTransportVoyageNumber,
  findDuplicateTransportVoyageNumbers,
  normalizeTransportVoyageNumber,
} from "./transportVoyageNumber";

test("extracts the value printed under No Voyage", () => {
  assert.equal(
    extractTransportVoyageNumber(
      "Chargement voyage\nNo Voyage\n14066\nID Camion",
    ),
    "14066",
  );
  assert.equal(extractTransportVoyageNumber("N° Voyage: AB-1207"), "AB-1207");
});

test("normalizes recognized voyage numbers without accepting a whole label", () => {
  assert.equal(normalizeTransportVoyageNumber(" 14 066 "), "14066");
  assert.equal(normalizeTransportVoyageNumber("No voyage illisible"), null);
});

test("detects a repeated voyage across plan items and supports legacy text", () => {
  assert.deepEqual(
    findDuplicateTransportVoyageNumbers([
      { recognized_voyage_number: "14066" },
      { recognized_text: "No Voyage\n14066" },
      { recognized_voyage_number: "14067" },
    ]),
    ["14066"],
  );
});
