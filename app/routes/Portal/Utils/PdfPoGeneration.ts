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

const defaultBuyerInfos : {
  name: string | null
  email: string | null
} = {
  name: "Ricardo Molière",
  email: "achats@vegibec.com",
}

const formatMoney = (value: number | null | undefined) => {
  if (value === null || value === undefined) return ""

  return Number(value).toFixed(2)
}

const formatDateIso = (value: string | Date | null | undefined) => {
  if (!value) return ""

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10)
  }

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) return ""

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")

  return `${year}-${month}-${day}`
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

  const drawLines = (
    text: string | null | undefined,
    x: number,
    y: number,
    options?: {
      size?: number
      bold?: boolean
      lineHeight?: number
      maxLines?: number
    },
  ) => {
    if (!text) return

    const lines = text
      .split(/\r?\n|,/)
      .map((line) => line.trim())
      .filter(Boolean)

    const maxLines = options?.maxLines ?? lines.length
    const lineHeight = options?.lineHeight ?? 12

    lines.slice(0, maxLines).forEach((line, index) => {
      drawText(line, x, y - index * lineHeight, {
        size: options?.size,
        bold: options?.bold,
      })
    })
  }

  const purchasedAtFormatted = formatDateIso(purchaseOrder.purchased_at)

  const displayReference =
   purchaseOrder.purchase_order_reference 

  // Header / PO number
  drawText(displayReference, 470, 720, { size: 14, bold: true })

  // Acheté de
  drawText(purchaseOrder.supplier_name, 26, 610, {
    size: 10,
    bold: true,
  })

  drawLines(purchaseOrder.supplier_address_snapshot, 26, 596, {
    size: 9,
    lineHeight: 12,
    maxLines: 4,
  })

  drawText(purchaseOrder.supplier_phone, 26, 540, {
    size: 9,
  })

  // Expédié à
  // The template already contains Vegibec's shipping address.
  // Only draw this if you want to override or add custom shipping info.
  // drawLines(purchaseOrder.shipping_address_snapshot, 228, 604, {
  //   size: 9,
  //   lineHeight: 12,
  //   maxLines: 5,
  // })

  // Acheteur
  drawText(defaultBuyerInfos.name, 228, 501, {
    size: 9,
  })

  drawText(defaultBuyerInfos.email, 228, 490, {
    size: 9,
  })

  // Right box
  drawText(purchasedAtFormatted, 422, 605, {
    size: 9,
  })

  drawText(purchaseOrder.delivery_method, 422, 540, {
    size: 9,
  })

  // Items table
  const ITEM_START_Y = 410
  const ITEM_ROW_HEIGHT = 30

  purchaseOrder.items.forEach((item, index) => {
    const y = ITEM_START_Y - index * ITEM_ROW_HEIGHT

    drawText(item.item_code, 26, y)
    drawText(item.item_description, 76, y)
    drawText(item.ordered_quantity, 318, y)
    drawText(item.ordered_unit, 391, y)
    drawText(formatMoney(item.final_unit_price), 457, y)
    drawText(formatMoney(item.final_total_price), 527, y)
  })

  const total = purchaseOrder.items.reduce(
    (sum, item) => sum + Number(item.final_total_price ?? 0),
    0,
  )

  drawText(`${formatMoney(total)} ${purchaseOrder.currency_code ?? "CAD"}`, 485, 120, {
    size: 12,
    bold: true,
  })

  return await pdfDoc.save()
}



