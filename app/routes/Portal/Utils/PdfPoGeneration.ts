import fs from "fs/promises"
import path from "path"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

type PurchaseOrderPdfItem = {
  item_code: string | null
  item_description: string | null
  ordered_quantity: number | string | null
  ordered_unit: string | null
  number_of_pallets: number | string | null
  final_unit_price: number | string | null
  final_total_price: number | string | null
  location: string | null
}

type PurchaseOrderPdfData = {
  purchase_order_reference: string
  purchase_order_subsequence: number | null
  supplier_name: string | null
  supplier_address_snapshot: string | null
  supplier_phone: string | number | null
  phone?: string | number | null
  buyer_name: string | null
  buyer_email: string | null
  buyer_phone?: string | number | null
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

const formatNumber = (
  value: number | string | null | undefined,
  options?: {
    decimals?: number
    hideDecimalsIfInteger?: boolean
  },
) => {
  if (value === null || value === undefined || value === "") return ""

  const numberValue = Number(value)

  if (Number.isNaN(numberValue)) return ""

  if (options?.hideDecimalsIfInteger && Number.isInteger(numberValue)) {
    return String(numberValue)
  }

  return numberValue.toFixed(options?.decimals ?? 2)
}

const formatMoney = (value: number | string | null | undefined) => {
  return formatNumber(value, {
    decimals: 2,
  })
}

const formatQuantity = (value: number | string | null | undefined) => {
  return formatNumber(value, {
    decimals: 2,
    hideDecimalsIfInteger: true,
  })
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

const formatDateTime = (value: Date) => {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, "0")
  const day = String(value.getDate()).padStart(2, "0")
  const hours = String(value.getHours()).padStart(2, "0")
  const minutes = String(value.getMinutes()).padStart(2, "0")

  return `${year}-${month}-${day} ${hours}:${minutes}`
}

const translateDeliveryMethod = (
  value: string | null,
  language: "fr" | "en",
) => {
  if (!value || language === "fr") return value

  const normalizedValue = value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()

  if (normalizedValue === "livre") return "Delivered"
  if (normalizedValue === "ramasse") return "Pick up"

  return value
}

const ITEMS_PER_PAGE = 8

const generatePurchaseOrderPdfPage = async (
  purchaseOrder: PurchaseOrderPdfData,
  language: "fr" | "en" = "fr",
  options?: {
    showSummary?: boolean
    summaryItems?: PurchaseOrderPdfItem[]
  },
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

  if (language === "en") {
    const green = rgb(0.12, 0.31, 0.1)
    const tableHeaderBackground = rgb(0.965, 0.973, 0.965)
    const replaceLabel = (
      text: string,
      x: number,
      y: number,
      width: number,
      height: number,
      size: number,
      color = green,
      background = rgb(1, 1, 1),
    ) => {
      page.drawRectangle({ x, y, width, height, color: background })
      page.drawText(text, { x, y: y + 2, size, font: boldFont, color })
    }

    // Keep the original template geometry and replace only its French labels.
    page.drawRectangle({ x: 405, y: 704, width: 190, height: 90, color: rgb(1, 1, 1) })
    page.drawText("Purchase order", { x: 437, y: 767, size: 19, font: boldFont, color: rgb(0, 0, 0) })
    // The complete order-number line is drawn below with the dynamic reference.
    replaceLabel("Purchased from", 36, 627, 105, 18, 10)
    replaceLabel("Shipped to", 229, 627, 91, 18, 10)
    replaceLabel("Order date", 422, 618, 105, 18, 10)
    page.drawRectangle({ x: 225, y: 500, width: 82, height: 30, color: rgb(1, 1, 1) })
    page.drawText("Buyer", { x: 229, y: 517, size: 10, font: boldFont, color: green })
    replaceLabel("Delivery method", 422, 552, 125, 18, 10)
    replaceLabel("Code", 40, 436, 48, 16, 9, rgb(0, 0, 0), tableHeaderBackground)
    replaceLabel("Description", 165, 436, 72, 16, 9, rgb(0, 0, 0), tableHeaderBackground)
    replaceLabel("Quantity", 304, 436, 67, 16, 9, rgb(0, 0, 0), tableHeaderBackground)
    replaceLabel("Unit", 375, 436, 50, 16, 9, rgb(0, 0, 0), tableHeaderBackground)
    replaceLabel("Price", 448, 436, 42, 16, 9, rgb(0, 0, 0), tableHeaderBackground)
    replaceLabel("Amount", 517, 436, 54, 16, 9, rgb(0, 0, 0), tableHeaderBackground)
    replaceLabel("Page 1 of 1", 521, 22, 57, 14, 7, rgb(0, 0, 0))
  }

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

  const getTextWidth = (
  text: string | number | null | undefined,
  size = 9,
  options?: {
    bold?: boolean
  },
) => {
  if (text === null || text === undefined || text === "") return 0

  const selectedFont = options?.bold ? boldFont : font

  return selectedFont.widthOfTextAtSize(String(text), size)
}

const drawFittedText = (
  text: string | number | null | undefined,
  x: number,
  y: number,
  maxWidth: number,
  options?: {
    size?: number
    bold?: boolean
  },
) => {
  if (text === null || text === undefined || text === "") return

  const size = options?.size ?? 9
  const textAsString = String(text)
  const selectedFont = options?.bold ? boldFont : font

  if (selectedFont.widthOfTextAtSize(textAsString, size) <= maxWidth) {
    drawText(textAsString, x, y, options)
    return
  }

  let fittedText = textAsString

  while (
    fittedText.length > 1 &&
    selectedFont.widthOfTextAtSize(`${fittedText}…`, size) > maxWidth
  ) {
    fittedText = fittedText.slice(0, -1)
  }

  drawText(`${fittedText}…`, x, y, options)
}

const drawRightAlignedText = (
  text: string | number | null | undefined,
  rightX: number,
  y: number,
  options?: {
    size?: number
    bold?: boolean
  },
) => {
  if (text === null || text === undefined || text === "") return

  const size = options?.size ?? 9
  const textAsString = String(text)
  const textWidth = getTextWidth(textAsString, size, {
    bold: options?.bold,
  })

  page.drawText(textAsString, {
    x: rightX - textWidth,
    y,
    size,
    font: options?.bold ? boldFont : font,
    color: rgb(0, 0, 0),
  })
}


const TABLE_COLUMNS = {
  leftX: 16,
  rightX: 580,

  codeX: 26,
  descriptionX: 76,
  descriptionMaxWidth: 215,
  descriptionMaxCharacters: 52,

  quantityRightX: 355,
  unitX: 370,
  unitMaxWidth: 70,

  priceRightX: 493,
  amountRightX: 568,

  totalPriceLeftX: 500,
  currencyRightX: 568,
}

const FOOTER_COLUMNS = {
  generatedAtRightX: 568,
  generatedAtY: 35,
}

const HEADER_COLUMNS = {
  orderReferenceLabelX: 480.5,
  orderReferenceY: 720,
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
    maxWidth?: number
  },
) => {
  if (!text) return

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const maxLines = options?.maxLines ?? lines.length
  const lineHeight = options?.lineHeight ?? 12

  lines.slice(0, maxLines).forEach((line, index) => {
    const lineY = y - index * lineHeight

    if (options?.maxWidth) {
      drawFittedText(line, x, lineY, options.maxWidth, {
        size: options?.size,
        bold: options?.bold,
      })
      return
    }

    drawText(line, x, lineY, {
      size: options?.size,
      bold: options?.bold,
    })
  })
}

  const splitDescriptionText = (
    text: string | null | undefined,
    maxWidth: number,
    maxCharacters: number,
    maxLines = 3,
    size = 9,
  ) => {
    if (!text) return []

    const words = text.trim().split(/\s+/)
    const lines: string[] = []
    let currentLine = ""

    words.forEach((word) => {
      const nextLine = currentLine ? `${currentLine} ${word}` : word

      if (
        nextLine.length <= maxCharacters &&
        font.widthOfTextAtSize(nextLine, size) <= maxWidth
      ) {
        currentLine = nextLine
        return
      }

      if (currentLine) lines.push(currentLine)

      if (
        word.length <= maxCharacters &&
        font.widthOfTextAtSize(word, size) <= maxWidth
      ) {
        currentLine = word
        return
      }

      let remainingWord = word

      while (remainingWord) {
        let chunk = remainingWord

        while (
          chunk.length > 1 &&
          (chunk.length > maxCharacters ||
            font.widthOfTextAtSize(chunk, size) > maxWidth)
        ) {
          chunk = chunk.slice(0, -1)
        }

        lines.push(chunk)
        remainingWord = remainingWord.slice(chunk.length)
      }

      currentLine = ""
    })

    if (currentLine) lines.push(currentLine)

    return lines.slice(0, maxLines)
  }

  const purchasedAtFormatted = formatDateIso(purchaseOrder.purchased_at)
  const supplierPhone = purchaseOrder.supplier_phone ?? purchaseOrder.phone

  const displayReference =
   purchaseOrder.purchase_order_reference 

  // Header / PO number
  if (language === "en") {
    drawRightAlignedText(`# Order ${displayReference}`, 575, HEADER_COLUMNS.orderReferenceY, {
      size: 14,
      bold: true,
    })
  } else {
    drawRightAlignedText(
      displayReference,
      HEADER_COLUMNS.orderReferenceLabelX +
        getTextWidth("# Commande", 14, { bold: true }),
      HEADER_COLUMNS.orderReferenceY,
      { size: 14, bold: true },
    )
  }

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

  drawText(supplierPhone, 26, 540, {
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
  drawText(purchaseOrder.buyer_name ? purchaseOrder.buyer_name : defaultBuyerInfos.name, 228, 501, {
    size: 9,
  })

  drawText(purchaseOrder.buyer_email ? purchaseOrder.buyer_email : defaultBuyerInfos.email, 228, 490, {
    size: 9,
  })

  drawText(purchaseOrder.buyer_phone, 228, 479, {
    size: 9,
  })

  // Right box
  drawText(purchasedAtFormatted, 422, 605, {
    size: 9,
  })

  drawText(translateDeliveryMethod(purchaseOrder.delivery_method, language), 422, 540, {
    size: 9,
  })

  // Items table
const ITEM_START_Y = 410
const ITEM_ROW_HEIGHT = 30
const ITEM_DESCRIPTION_LINE_HEIGHT = 10
const THREE_LINE_DESCRIPTION_EXTRA_SPACING = 6

let itemYOffset = 0

purchaseOrder.items.forEach((item) => {
  const y = ITEM_START_Y - itemYOffset

  const descriptionLines = splitDescriptionText(
    item.item_description,
    TABLE_COLUMNS.descriptionMaxWidth,
    TABLE_COLUMNS.descriptionMaxCharacters,
  )

  drawText(item.item_code, TABLE_COLUMNS.codeX, y)

  descriptionLines.forEach((line, lineIndex) => {
    drawText(
      line,
      TABLE_COLUMNS.descriptionX,
      y - lineIndex * ITEM_DESCRIPTION_LINE_HEIGHT,
    )
  })

  drawRightAlignedText(
    formatQuantity(item.ordered_quantity),
    TABLE_COLUMNS.quantityRightX,
    y,
  )

  drawFittedText(
    item.ordered_unit,
    TABLE_COLUMNS.unitX,
    y,
    TABLE_COLUMNS.unitMaxWidth,
  )

  drawRightAlignedText(
    formatMoney(item.final_unit_price),
    TABLE_COLUMNS.priceRightX,
    y,
  )

  drawRightAlignedText(
    formatMoney(item.final_total_price),
    TABLE_COLUMNS.amountRightX,
    y,
  )

  itemYOffset += ITEM_ROW_HEIGHT

  if (descriptionLines.length === 3) {
    itemYOffset += THREE_LINE_DESCRIPTION_EXTRA_SPACING
  }
})

  const summaryItems = options?.summaryItems ?? purchaseOrder.items
  const total = summaryItems.reduce(
    (sum, item) => sum + Number(item.final_total_price ?? 0),
    0,
  )
  const totalQuantity = summaryItems.reduce(
    (sum, item) => sum + Number(item.ordered_quantity ?? 0),
    0,
  )

if (options?.showSummary !== false) {
page.drawLine({
  start: { x: TABLE_COLUMNS.leftX, y: 116 },
  end: { x: TABLE_COLUMNS.rightX, y: 116 },
  thickness: 0.5,
  color: rgb(0.82, 0.82, 0.82),
})


drawRightAlignedText(
  formatQuantity(totalQuantity),
  TABLE_COLUMNS.quantityRightX,
  99,
  {
    size: 10,
    bold: true,
  },
)

drawRightAlignedText(formatMoney(total), TABLE_COLUMNS.currencyRightX, 102, {
  size: 11,
  bold: true,
})

drawRightAlignedText(
  purchaseOrder.currency_code ?? "CAD",
  TABLE_COLUMNS.currencyRightX,
  92,
  {
    size: 8,
  },
)
}

drawRightAlignedText(formatDateTime(new Date()), FOOTER_COLUMNS.generatedAtRightX, FOOTER_COLUMNS.generatedAtY, {
  size: 8,
})

  return await pdfDoc.save()
}

export const generatePurchaseOrderPdf = async (
  purchaseOrder: PurchaseOrderPdfData,
  language: "fr" | "en" = "fr",
) => {
  if (purchaseOrder.items.length <= ITEMS_PER_PAGE) {
    return generatePurchaseOrderPdfPage(purchaseOrder, language)
  }

  const chunks: PurchaseOrderPdfItem[][] = []
  for (let index = 0; index < purchaseOrder.items.length; index += ITEMS_PER_PAGE) {
    chunks.push(purchaseOrder.items.slice(index, index + ITEMS_PER_PAGE))
  }

  const output = await PDFDocument.create()
  const font = await output.embedFont(StandardFonts.Helvetica)
  const boldFont = await output.embedFont(StandardFonts.HelveticaBold)

  for (let index = 0; index < chunks.length; index += 1) {
    const pageBytes = await generatePurchaseOrderPdfPage(
      { ...purchaseOrder, items: chunks[index] },
      language,
      {
        showSummary: index === chunks.length - 1,
        summaryItems: purchaseOrder.items,
      },
    )
    const source = await PDFDocument.load(pageBytes)
    const [page] = await output.copyPages(source, [0])
    output.addPage(page)
  }

  output.getPages().forEach((page, index) => {
    page.drawRectangle({
      x: 449,
      y: 18,
      width: 133,
      height: 22,
      color: rgb(1, 1, 1),
    })

    const pageLabel =
      language === "en"
        ? `Page ${index + 1} of ${chunks.length}`
        : `Page ${index + 1} de ${chunks.length}`
    const pageLabelWidth = font.widthOfTextAtSize(pageLabel, 8)
    page.drawText(pageLabel, {
      x: 575 - pageLabelWidth,
      y: 24,
      size: 8,
      font,
      color: rgb(0, 0, 0),
    })

    if (index < chunks.length - 1) {
      const continuation =
        language === "en" ? "Continued on next page" : "Suite à la page suivante"
      const continuationWidth = boldFont.widthOfTextAtSize(continuation, 8)
      page.drawText(continuation, {
        x: 575 - continuationWidth,
        y: 36,
        size: 8,
        font: boldFont,
        color: rgb(0.12, 0.31, 0.1),
      })
    }
  })

  return output.save()
}



