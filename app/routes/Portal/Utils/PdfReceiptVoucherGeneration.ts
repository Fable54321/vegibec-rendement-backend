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
  supplier_name?: string | null
  supplier_address_snapshot?: string | null
  supplier_phone?: string | number | null
  delivery_method?: string | null
  received_at?: string | Date | null
  received_by_name?: string | null
  received_by_email?: string | null
  receipt_note?: string | null
  purchase_order_references?: string[] | null
  items: ReceiptVoucherPdfItem[]
}

const defaultReceiverInfos: {
  name: string | null
  email: string | null
} = {
  name: "Ricardo Molière",
  email: "achats@vegibec.com",
}

const TABLE_COLUMNS = {
  leftX: 56,
  rightX: 548,

  // Left-aligned inside Code column
  codeX: 58,
  codeMaxWidth: 54,

  // Left-aligned inside Description column
  descriptionX: 119,
  descriptionMaxWidth: 220,
  descriptionMaxCharacters: 48,

  // Right-aligned inside quantity columns
  quantityRightX: 385,
  receivedQuantityRightX: 456,

  // Left-aligned inside Commentaire column
  commentX: 482,
  commentMaxWidth: 58,
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

  const drawFittedRightAlignedText = (
    text: string | number | null | undefined,
    rightX: number,
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
      drawRightAlignedText(textAsString, rightX, y, options)
      return
    }

    let fittedText = textAsString

    while (
      fittedText.length > 1 &&
      selectedFont.widthOfTextAtSize(`${fittedText}...`, size) > maxWidth
    ) {
      fittedText = fittedText.slice(0, -1)
    }

    drawRightAlignedText(`${fittedText}...`, rightX, y, options)
  }

  const drawLines = (
    text: string | number | null | undefined,
    x: number,
    y: number,
    options?: {
      size?: number
      bold?: boolean
      lineHeight?: number
      maxLines?: number
    },
  ) => {
    if (text === null || text === undefined || text === "") return

    const lines = String(text)
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

  const purchaseOrderReferences = [
    ...new Set([
      ...(receiptVoucher.purchase_order_references ?? []),
      ...receiptVoucher.items
        .map((item) => item.purchase_order_reference)
        .filter(Boolean),
    ]),
  ].filter(Boolean)

  const orderedTotal = receiptVoucher.items.reduce(
    (sum, item) => sum + Number(item.quantity ?? 0),
    0,
  )

  const receivedTotal = receiptVoucher.items.reduce(
    (sum, item) => sum + Number(item.received_quantity ?? 0),
    0,
  )

  drawRightAlignedText(receiptVoucher.receipt_voucher_reference, 545.5, 662, {
    size: 14,
    bold: true,
  })

  const commandReferencesToDraw =
    purchaseOrderReferences.length > 0
      ? purchaseOrderReferences
      : receiptVoucher.request_reference
        ? [receiptVoucher.request_reference]
        : []

  commandReferencesToDraw.slice(0, 2).forEach((reference, index) => {
    drawFittedRightAlignedText(reference, 560, 632 - index * 10, 125, {
      size: 8,
    })
  })

  drawFittedText(receiptVoucher.supplier_name, 67, 576, 150, {
    size: 9,
    bold: true,
  })
  drawLines(receiptVoucher.supplier_address_snapshot, 67, 563, {
    size: 8,
    lineHeight: 10,
    maxLines: 4,
  })
  drawFittedText(receiptVoucher.supplier_phone, 67, 517, 120, {
    size: 8,
  })

drawText(formatDateIso(receiptVoucher.received_at), 400, 524, {
  size: 9,
})

  drawFittedText(receiptVoucher.delivery_method, 400, 475, 120, {
    size: 9,
  })

  drawFittedText(
    receiptVoucher.received_by_name || defaultReceiverInfos.name,
    234,
    470,
    178,
    {
      size: 9,
    },
  )

  drawFittedText(
    receiptVoucher.received_by_email || defaultReceiverInfos.email,
    234,
    459,
    178,
    {
      size: 9,
    },
  )

  drawFittedText(receiptVoucher.receipt_note, 235, 452, 178, {
    size: 8,
  })

  const itemStartY = 392
  const rowHeight = 30
  const descriptionLineHeight = 10
  const threeLineDescriptionExtraSpacing = 6
  const minimumRowY = 112

  let yOffset = 0

  receiptVoucher.items.forEach((item) => {
    const y = itemStartY - yOffset

    if (y < minimumRowY) return

    const description =
      item.item_description ?? item.description ?? "Article sans description"

    const descriptionLines = splitDescriptionText(
      description,
      TABLE_COLUMNS.descriptionMaxWidth,
      TABLE_COLUMNS.descriptionMaxCharacters,
      3,
    )

    drawFittedText(
      item.item_code,
      TABLE_COLUMNS.codeX,
      y,
      TABLE_COLUMNS.codeMaxWidth,
      {
        size: 9,
      },
    )

    descriptionLines.forEach((line, index) => {
      drawText(
        line,
        TABLE_COLUMNS.descriptionX,
        y - index * descriptionLineHeight,
        {
          size: 9,
        },
      )
    })

    drawRightAlignedText(
      formatQuantity(item.quantity),
      TABLE_COLUMNS.quantityRightX,
      y,
      {
        size: 9,
      },
    )

    drawRightAlignedText(
      formatQuantity(item.received_quantity),
      TABLE_COLUMNS.receivedQuantityRightX,
      y,
      {
        size: 9,
        bold: true,
      },
    )

    drawFittedText(
      item.comment,
      TABLE_COLUMNS.commentX,
      y,
      TABLE_COLUMNS.commentMaxWidth,
      {
        size: 8,
      },
    )

    yOffset += rowHeight

    if (descriptionLines.length === 3) {
      yOffset += threeLineDescriptionExtraSpacing
    }
  })

  drawRightAlignedText(
    formatQuantity(orderedTotal),
    TABLE_COLUMNS.quantityRightX,
    133,
    {
      size: 10,
      bold: true,
    },
  )

  drawRightAlignedText(
    formatQuantity(receivedTotal),
    TABLE_COLUMNS.receivedQuantityRightX,
    133,
    {
      size: 10,
      bold: true,
    },
  )

  drawRightAlignedText(formatDateTime(new Date()), 560, 35, {
    size: 8,
  })

  return await pdfDoc.save()
}
