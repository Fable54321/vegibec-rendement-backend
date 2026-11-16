import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProductCode,
  resolveProductCode,
} from "./transportProductCode";

type Product = {
  id: number;
  product_code: string;
  full_name: string;
};

const products: Product[] = [
  { id: 1, product_code: "668", full_name: "Poivrons rouges cello" },
  { id: 2, product_code: "868", full_name: "Choux rouges sac" },
  { id: 3, product_code: "800", full_name: "Choux Bruxelles" },
];
const productsByCode = new Map(
  products.map((product) => [normalizeProductCode(product.product_code), product]),
);

test("corrects an unknown code when replacing OCR 8 with 6 gives one catalog match", () => {
  const result = resolveProductCode(
    "888",
    "Poivrons rouges cello",
    new Map([["668", products[0]]]),
  );

  assert.equal(result.product?.product_code, "668");
  assert.equal(result.corrected, true);
});

test("uses the item name to choose between multiple 8-to-6 candidates", () => {
  const result = resolveProductCode("888", "Choux rouges sac", productsByCode);

  assert.equal(result.product?.product_code, "868");
  assert.equal(result.corrected, true);
});

test("preserves a legitimate exact code", () => {
  const result = resolveProductCode("800", "Choux Bruxelles", productsByCode);

  assert.equal(result.product?.product_code, "800");
  assert.equal(result.corrected, false);
});

test("overrides an exact 8 code only when the item name clearly identifies a 6 variant", () => {
  const catalog = new Map([
    ["668", products[0]],
    [
      "888",
      { id: 4, product_code: "888", full_name: "Carottes nantaises" },
    ],
  ]);
  const result = resolveProductCode("888", "Poivrons rouges cello", catalog);

  assert.equal(result.product?.product_code, "668");
  assert.equal(result.corrected, true);
});

test("does not guess between ambiguous candidates without a useful item name", () => {
  const result = resolveProductCode("888", null, productsByCode);

  assert.equal(result.product, null);
  assert.equal(result.corrected, false);
});

test("does not correct unrelated OCR differences", () => {
  const result = resolveProductCode("667", "Poivrons rouges cello", productsByCode);

  assert.equal(result.product, null);
  assert.equal(result.corrected, false);
});
