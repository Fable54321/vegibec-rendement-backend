import fs from "fs/promises"
import path from "path"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

type PurchaseOrderPdfItem = {
  item_code: string | null
  item_description: string | null
  ordered_quantity: number | null
  ordered_unit: string | null
  number_of_pallets: number | null
  final_unit_price: number | null
  final_total_price: number | null
  location: string | null
}

type PurchaseOrderPdfData = {
  purchase_order_reference: string
  purchase_order_subsequence: number | null
  supplier_name: string | null
  supplier_address_snapshot: string | null
  supplier_phone: string | null
  buyer_name: string | null
  buyer_email: string | null
  requested_delivery_date: string | null
  purchased_at: string | null
  supplier_reference: string | null
  invoice_number: string | null
  delivery_method: string | null
  shipping_address_snapshot: string | null
  currency_code: string | null
  items: PurchaseOrderPdfItem[]
}

const formatDisplayReference = (purchaseOrder: PurchaseOrderPdfData) => {
  if (purchaseOrder.purchase_order_subsequence === null) {
    return purchaseOrder.purchase_order_reference
  }

  return `${purchaseOrder.purchase_order_reference}-${String(
    purchaseOrder.purchase_order_subsequence,
  ).padStart(2, "0")}`
}

const formatMoney = (value: number | null | undefined) => {
  if (value === null || value === undefined) return ""

  return Number(value).toFixed(2)
}

export const generatePurchaseOrderPdf = async (
  purchaseOrder: PurchaseOrderPdfData,
) => {
  const templatePath = path.resolve(
    process.cwd(),
    "public",
    "templates",
    "bonDeCommandeV2.pdf",
  )

  const templateBytes = await fs.readFile(templatePath)

  const pdfDoc = await PDFDocument.load(templateBytes)
  const page = pdfDoc.getPages()[0]

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const drawText = (
    text: string | number | null | undefined,
    x: number,
    y: number,
    options?: {
      size?: number
      bold?: boolean
    },
  ) => {
    if (text === null || text === undefined || text === "") return

    page.drawText(String(text), {
      x,
      y,
      size: options?.size ?? 9,
      font: options?.bold ? boldFont : font,
      color: rgb(0, 0, 0),
    })
  }

  const displayReference = formatDisplayReference(purchaseOrder)

  drawText(displayReference, 475, 692, { size: 14, bold: true })

  drawText(purchaseOrder.supplier_name, 70, 620, { bold: true })
  drawText(purchaseOrder.supplier_address_snapshot, 70, 606)
  drawText(purchaseOrder.supplier_phone, 70, 570)

  drawText(purchaseOrder.shipping_address_snapshot, 330, 606)

  drawText(purchaseOrder.supplier_reference, 155, 540)
  drawText(purchaseOrder.purchased_at, 330, 540)
  drawText(purchaseOrder.requested_delivery_date, 330, 520)
  drawText(purchaseOrder.invoice_number, 475, 520)

  drawText(purchaseOrder.buyer_name, 70, 500)
  drawText(purchaseOrder.buyer_email, 70, 486)

  let y = 410

  for (const item of purchaseOrder.items) {
    drawText(item.item_code, 35, y)
    drawText(item.item_description, 85, y)
    drawText(item.ordered_quantity, 300, y)
    drawText(item.ordered_unit, 340, y)
    drawText(item.number_of_pallets, 380, y)
    drawText(formatMoney(item.final_unit_price), 425, y)
    drawText(formatMoney(item.final_total_price), 485, y)
    drawText(item.location, 545, y)

    y -= 18
  }

  const total = purchaseOrder.items.reduce(
    (sum, item) => sum + Number(item.final_total_price ?? 0),
    0,
  )

  drawText(`${formatMoney(total)} ${purchaseOrder.currency_code ?? "CAD"}`, 475, 120, {
    size: 12,
    bold: true,
  })

  return await pdfDoc.save()
}



