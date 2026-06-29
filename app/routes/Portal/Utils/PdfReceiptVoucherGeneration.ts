import fs from "fs/promises"
import path from "path"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

type ReceiptVoucherPdfItem = {
  item_code?: string | null
  item_description?: string | null
  description?: string | null
  quantity?: number | string | null
  received_quantity?: number | string | null
  ordered_unit?: string | null
  comment?: string | null
  purchase_order_reference?: string | null
}

type ReceiptVoucherPdfData = {
  receipt_voucher_reference: string
  request_reference?: string | null
  received_at?: string | Date | null
  received_by_name?: string | null
  received_by_email?: string | null
  receipt_note?: string | null
  purchase_order_references?: string[] | null
  items: ReceiptVoucherPdfItem[]
}

const defaultReceiverInfos : {
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

export const generateReceiptVoucherPdf = async (
  receiptVoucher: ReceiptVoucherPdfData,
) => {
  const templatePath = path.resolve(
    process.cwd(),
    "public",
    "templates",
    "bon_de_receptionV2.pdf",
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

    drawText(textAsString, rightX - textWidth, y, options)
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
      selectedFont.widthOfTextAtSize(`${fittedText}...`, size) > maxWidth
    ) {
      fittedText = fittedText.slice(0, -1)
    }

    drawText(`${fittedText}...`, x, y, options)
  }

  const splitText = (
    text: string | null | undefined,
    maxWidth: number,
    maxCharacters: number,
    maxLines = 2,
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
      currentLine = word
    })

    if (currentLine) lines.push(currentLine)

    return lines.slice(0, maxLines)
  }


  const purchaseOrderReferences = [
    ...new Set(receiptVoucher.purchase_order_references ?? []),
  ]
    .filter(Boolean)
    .join(", ")

  drawRightAlignedText(receiptVoucher.receipt_voucher_reference, 560, 733, {
    size: 14,
    bold: true,
  })
  drawText(receiptVoucher.request_reference, 88, 682, { size: 10, bold: true })
  drawText(formatDateIso(receiptVoucher.received_at), 412, 682, { size: 10 })
  drawText(receiptVoucher.received_by_name ? receiptVoucher.received_by_name : defaultReceiverInfos.name, 88, 660, { size: 9 })
  drawText(receiptVoucher.received_by_email ? receiptVoucher.received_by_email : defaultReceiverInfos.email, 88, 638, { size: 9 })
  drawFittedText(purchaseOrderReferences, 88, 638, 460, { size: 9 })
  drawFittedText(receiptVoucher.receipt_note, 88, 616, 460, { size: 9 })

  const columns = {
    poX: 24,
    codeX: 100,
    descriptionX: 154,
    descriptionMaxWidth: 210,
    orderedRightX: 418,
    receivedRightX: 482,
    unitX: 494,
    unitMaxWidth: 44,
    commentX: 542,
    commentMaxWidth: 38,
  }

  const itemStartY = 522
  const rowHeight = 28
  const lineHeight = 10
  let yOffset = 0

  receiptVoucher.items.forEach((item) => {
    const y = itemStartY - yOffset

    if (y < 102) return

    const description =
      item.item_description ?? item.description ?? "Article sans description"
    const descriptionLines = splitText(
      description,
      columns.descriptionMaxWidth,
      46,
      2,
    )

    drawFittedText(item.purchase_order_reference, columns.poX, y, 68)
    drawFittedText(item.item_code, columns.codeX, y, 46)

    descriptionLines.forEach((line, index) => {
      drawText(line, columns.descriptionX, y - index * lineHeight)
    })

    drawRightAlignedText(formatQuantity(item.quantity), columns.orderedRightX, y)
    drawRightAlignedText(
      formatQuantity(item.received_quantity),
      columns.receivedRightX,
      y,
      { bold: true },
    )
    drawFittedText(item.ordered_unit, columns.unitX, y, columns.unitMaxWidth)
    drawFittedText(item.comment, columns.commentX, y, columns.commentMaxWidth, {
      size: 8,
    })

    yOffset += rowHeight
  })

  const orderedTotal = receiptVoucher.items.reduce(
    (sum, item) => sum + Number(item.quantity ?? 0),
    0,
  )
  const receivedTotal = receiptVoucher.items.reduce(
    (sum, item) => sum + Number(item.received_quantity ?? 0),
    0,
  )

  page.drawLine({
    start: { x: 20, y: 86 },
    end: { x: 575, y: 86 },
    thickness: 0.5,
    color: rgb(0.82, 0.82, 0.82),
  })

  drawRightAlignedText(formatQuantity(orderedTotal), columns.orderedRightX, 70, {
    size: 10,
    bold: true,
  })
  drawRightAlignedText(formatQuantity(receivedTotal), columns.receivedRightX, 70, {
    size: 10,
    bold: true,
  })
  drawRightAlignedText(formatDateTime(new Date()), 560, 35, {
    size: 8,
  })

  return await pdfDoc.save()
}
