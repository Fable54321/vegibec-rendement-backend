import assert from "node:assert/strict"
import test from "node:test"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import { generatePurchaseOrderPdf } from "./PdfPoGeneration"

test("purchase order PDF includes the purchase note as the final item", async () => {
  const bytes = await generatePurchaseOrderPdf({
    purchase_order_reference: "bc-26-11-01",
    purchase_order_subsequence: null,
    supplier_name: "Fournisseur test",
    supplier_address_snapshot: "123 rue Test",
    supplier_phone: "450-555-0100",
    buyer_name: "Acheteur test",
    buyer_email: "acheteur@example.com",
    buyer_phone: "450-555-0101",
    requested_delivery_date: "2026-11-30",
    purchased_at: "2026-11-20",
    supplier_reference: null,
    purchase_note: "Laisser la commande a la porte nord.",
    invoice_number: null,
    delivery_method: "Livre",
    shipping_address_snapshot: null,
    currency_code: "CAD",
    items: [
      {
        item_code: "TEST-1",
        item_description: "Article test",
        ordered_quantity: 2,
        ordered_unit: "caisse",
        number_of_pallets: null,
        final_unit_price: 12.5,
        final_total_price: 25,
        location: null,
      },
    ],
  })

  const document = await getDocument({ data: bytes }).promise
  const page = await document.getPage(1)
  const content = await page.getTextContent()
  const text = content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ")

  assert.match(text, /Note/)
  assert.match(text, /Laisser la commande a la porte nord\./)
})
