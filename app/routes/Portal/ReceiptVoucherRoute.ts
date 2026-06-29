// routes/Portal/ReceiptVoucherRoute.ts
import express from "express"
import type { PoolClient } from "pg"
import { pool } from "../../db"
import {
  getReceiptVoucherTokenFromRequest,
  validateReceiptVoucherToken,
} from "./Utils/PurchaseHelper"
import { generateReceiptVoucherPdf } from "./Utils/PdfReceiptVoucherGeneration"
import { getSignedUrlForKey, uploadBufferToS3 } from "../../services/s3.services"

const router = express.Router()

type ReceiptVoucherItemInput = {
  purchase_request_item_id?: number | null
  purchase_order_item_id?: number | null
  quantity?: number | string | null
  received_quantity?: number | string | null
  comment?: string | null
}

const toPositiveNumber = (value: unknown) => {
  const numberValue =
    typeof value === "string" ? Number(value.replace(",", ".")) : Number(value)

  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null
}

const toPositiveInteger = (value: unknown) => {
  const numberValue = Number(value)

  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null
}

const cleanText = (value: unknown) => {
  if (typeof value !== "string") return null

  const cleaned = value.trim()

  return cleaned.length > 0 ? cleaned : null
}

const createReceiptVoucherPdfKey = (
  receiptVoucherId: number,
  reference: string,
) => {
  const safeReference = reference.replace(/[^a-zA-Z0-9_-]/g, "-")

  return `portal/receipt-vouchers/${receiptVoucherId}/bon-reception-${safeReference}.pdf`
}

const createReceiptVoucherPdfFilename = (reference: string) => {
  const safeReference = reference.replace(/[^a-zA-Z0-9_-]/g, "-")

  return `bon-reception-${safeReference}.pdf`
}

const createPdfDownloadDisposition = (filename: string) => {
  return `attachment; filename="${filename}"`
}

const createPdfPreviewDisposition = (filename: string) => {
  return `inline; filename="${filename}"`
}

const getReceiptVoucherPdfKeys = (value: unknown) => {
  if (!value) return []

  if (Array.isArray(value)) {
    return value.filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    )
  }

  if (typeof value === "string") {
    return value ? [value] : []
  }

  return []
}

const ensureReceiptVoucherDocumentColumn = async (client: PoolClient) => {
  await client.query(`
    ALTER TABLE portal.receipt_vouchers
    ADD COLUMN IF NOT EXISTS receipt_document_keys text[]
  `)
}

const getReceiptVoucherPdfLinks = async (receiptVoucher: {
  id: number
  receipt_voucher_reference: string
  receipt_document_keys?: unknown
}) => {
  const keys = getReceiptVoucherPdfKeys(receiptVoucher.receipt_document_keys)
  const filename = createReceiptVoucherPdfFilename(
    receiptVoucher.receipt_voucher_reference,
  )

  return Promise.all(
    keys.map(async (key) => ({
      key,
      preview_url: await getSignedUrlForKey(key, {
        expiresIn: 60 * 60,
        responseContentDisposition: createPdfPreviewDisposition(filename),
        responseContentType: "application/pdf",
      }),
      download_url: await getSignedUrlForKey(key, {
        expiresIn: 60 * 60,
        responseContentDisposition: createPdfDownloadDisposition(filename),
        responseContentType: "application/pdf",
      }),
    })),
  )
}

const formatReceiptVoucherReference = (
  requestReference: string,
  sequence: number,
) => {
  if (sequence === 1) return requestReference

  return `${requestReference}-R${String(sequence).padStart(2, "0")}`
}

const getReceiptVoucherPdfData = async (
  client: PoolClient,
  receiptVoucherId: number,
) => {
  const voucherResult = await client.query(
    `
    SELECT
      rv.*,
      pr.request_reference,
      NULLIF(
        CONCAT_WS(' ', received_by.name, received_by.surname),
        ''
      ) AS received_by_name,
      received_by.email AS received_by_email
    FROM portal.receipt_vouchers rv
    INNER JOIN portal.purchase_requests pr
      ON pr.id = rv.purchase_request_id
    LEFT JOIN public.users received_by
      ON received_by.id = rv.received_by_user_id
    WHERE rv.id = $1
    `,
    [receiptVoucherId],
  )

  if (voucherResult.rows.length === 0) return null

  const itemsResult = await client.query(
    `
    SELECT
      rvi.*,
      poi.item_code,
      COALESCE(poi.item_description, pri.description) AS item_description,
      poi.ordered_unit,
      po.purchase_order_reference
    FROM portal.receipt_voucher_items rvi
    LEFT JOIN portal.purchase_order_items poi
      ON poi.id = rvi.purchase_order_item_id
    LEFT JOIN portal.purchase_orders po
      ON po.id = poi.purchase_order_id
    LEFT JOIN portal.purchase_request_items pri
      ON pri.id = rvi.purchase_request_item_id
    WHERE rvi.receipt_voucher_id = $1
    ORDER BY rvi.id ASC
    `,
    [receiptVoucherId],
  )

  const purchaseOrderReferences = [
    ...new Set(
      itemsResult.rows
        .map((item) => item.purchase_order_reference)
        .filter((reference): reference is string => !!reference),
    ),
  ]

  return {
    ...voucherResult.rows[0],
    purchase_order_references: purchaseOrderReferences,
    items: itemsResult.rows,
  }
}

router.get("/:receiptVoucherId/pdf", async (req, res) => {
  const client = await pool.connect()

  try {
    const receiptVoucherId = Number(req.params.receiptVoucherId)

    if (!Number.isInteger(receiptVoucherId) || receiptVoucherId <= 0) {
      return res.status(400).json({ message: "Invalid receipt voucher id" })
    }

    await ensureReceiptVoucherDocumentColumn(client)

    const voucherResult = await client.query(
      `
      SELECT id, receipt_voucher_reference, receipt_document_keys
      FROM portal.receipt_vouchers
      WHERE id = $1
      `,
      [receiptVoucherId],
    )

    if (voucherResult.rows.length === 0) {
      return res.status(404).json({ message: "Receipt voucher not found" })
    }

    const keys = getReceiptVoucherPdfKeys(
      voucherResult.rows[0].receipt_document_keys,
    )
    const shouldDownload =
      req.query.download === "1" || req.query.download === "true"

    if (keys.length > 0) {
      const filename = createReceiptVoucherPdfFilename(
        voucherResult.rows[0].receipt_voucher_reference,
      )
      const url = await getSignedUrlForKey(keys[0], {
        expiresIn: 60 * 60,
        responseContentDisposition: shouldDownload
          ? createPdfDownloadDisposition(filename)
          : createPdfPreviewDisposition(filename),
        responseContentType: "application/pdf",
      })

      return res.redirect(url)
    }

    const receiptVoucherPdfData = await getReceiptVoucherPdfData(
      client,
      receiptVoucherId,
    )

    if (!receiptVoucherPdfData) {
      return res.status(404).json({ message: "Receipt voucher not found" })
    }

    const pdfBytes = await generateReceiptVoucherPdf(receiptVoucherPdfData)
    const filename = createReceiptVoucherPdfFilename(
      receiptVoucherPdfData.receipt_voucher_reference,
    )

    res.setHeader("Content-Type", "application/pdf")
    res.setHeader(
      "Content-Disposition",
      shouldDownload
        ? createPdfDownloadDisposition(filename)
        : createPdfPreviewDisposition(filename),
    )

    return res.send(Buffer.from(pdfBytes))
  } catch (error) {
    console.error("Error generating receipt voucher PDF:", error)

    return res.status(500).json({
      message: "Error generating receipt voucher PDF",
    })
  } finally {
    client.release()
  }
})

router.get("/:receiptVoucherId/pdf-links", async (req, res) => {
  const client = await pool.connect()

  try {
    const receiptVoucherId = Number(req.params.receiptVoucherId)

    if (!Number.isInteger(receiptVoucherId) || receiptVoucherId <= 0) {
      return res.status(400).json({ message: "Invalid receipt voucher id" })
    }

    await ensureReceiptVoucherDocumentColumn(client)

    const voucherResult = await client.query(
      `
      SELECT id, receipt_voucher_reference, receipt_document_keys
      FROM portal.receipt_vouchers
      WHERE id = $1
      `,
      [receiptVoucherId],
    )

    if (voucherResult.rows.length === 0) {
      return res.status(404).json({ message: "Receipt voucher not found" })
    }

    const links = await getReceiptVoucherPdfLinks(voucherResult.rows[0])

    return res.json({
      receipt_voucher_id: voucherResult.rows[0].id,
      receipt_voucher_reference:
        voucherResult.rows[0].receipt_voucher_reference,
      receipt_voucher_pdf_links: links,
      receipt_voucher_pdf:
        links.length > 0
          ? {
              key: links[0].key,
              url: links[0].preview_url,
              preview_url: links[0].preview_url,
              download_url: links[0].download_url,
            }
          : null,
    })
  } catch (error) {
    console.error("Error getting receipt voucher PDF links:", error)

    return res.status(500).json({
      message: "Error getting receipt voucher PDF links",
    })
  } finally {
    client.release()
  }
})

router.post(["/", "/:id/:token", "/:id/reception/:token"], async (req, res) => {
  const client = await pool.connect()

  try {
    const {
      purchase_request_id,
      received_by_user_id,
      received_at,
      receipt_note,
      items,
    } = req.body ?? {}

    const purchaseRequestId =
      toPositiveInteger(req.params.id) || toPositiveInteger(purchase_request_id)
    const receivedByUserId = toPositiveInteger(received_by_user_id)

    if (!purchaseRequestId) {
      return res.status(400).json({
        message: "purchase_request_id is required",
      })
    }

    const receiptVoucherToken = getReceiptVoucherTokenFromRequest(req)
    const isReceiptVoucherTokenValid = await validateReceiptVoucherToken(
      client,
      purchaseRequestId,
      receiptVoucherToken,
    )

    if (!isReceiptVoucherTokenValid) {
      return res.status(403).json({
        message: "Invalid or expired receipt voucher token",
      })
    }

    if (!receivedByUserId) {
      return res.status(400).json({
        message: "received_by_user_id is required",
      })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: "At least one received item is required",
      })
    }

    const normalizedItems = items.map((item: ReceiptVoucherItemInput) => {
      const purchaseRequestItemId = toPositiveInteger(
        item.purchase_request_item_id,
      )
      const purchaseOrderItemId = toPositiveInteger(item.purchase_order_item_id)
      const quantity = toPositiveNumber(item.quantity)
      const receivedQuantity = toPositiveNumber(item.received_quantity)

      return {
        purchase_request_item_id: purchaseRequestItemId,
        purchase_order_item_id: purchaseOrderItemId,
        quantity,
        received_quantity: receivedQuantity,
        comment: cleanText(item.comment),
      }
    })

    const invalidItem = normalizedItems.find(
      (item) =>
        !item.purchase_request_item_id ||
        !item.quantity ||
        !item.received_quantity,
    )

    if (invalidItem) {
      return res.status(400).json({
        message:
          "Each item needs purchase_request_item_id, quantity, and received_quantity",
      })
    }

    await ensureReceiptVoucherDocumentColumn(client)

    await client.query("BEGIN")

    const requestResult = await client.query(
      `
      SELECT id, request_reference, status
      FROM portal.purchase_requests
      WHERE id = $1
      FOR UPDATE
      `,
      [purchaseRequestId],
    )

    if (requestResult.rows.length === 0) {
      await client.query("ROLLBACK")

      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const requestReference = requestResult.rows[0].request_reference
    const requestStatus = requestResult.rows[0].status

    if (requestStatus !== "purchased" && requestStatus !== "partially_received") {
      await client.query("ROLLBACK")

      return res.status(400).json({
        message: "This purchase request is not ready to receive",
      })
    }

    const itemIds = normalizedItems.map((item) => item.purchase_request_item_id)

    const requestItemsResult = await client.query(
      `
      SELECT id
      FROM portal.purchase_request_items
      WHERE purchase_request_id = $1
      AND id = ANY($2::bigint[])
      `,
      [purchaseRequestId, itemIds],
    )

    if (requestItemsResult.rows.length !== itemIds.length) {
      await client.query("ROLLBACK")

      return res.status(400).json({
        message: "One or more items do not belong to this purchase request",
      })
    }

    const purchaseOrderItemIds = normalizedItems
      .map((item) => item.purchase_order_item_id)
      .filter((id): id is number => !!id)
    const uniquePurchaseOrderItemIds = [...new Set(purchaseOrderItemIds)]

    if (uniquePurchaseOrderItemIds.length > 0) {
      const purchaseOrderItemsResult = await client.query(
        `
        SELECT
          poi.id,
          poi.ordered_quantity,
          COALESCE(received.received_quantity, 0)::numeric
            AS already_received_quantity
        FROM portal.purchase_order_items poi
        INNER JOIN portal.purchase_orders po
          ON po.id = poi.purchase_order_id
        LEFT JOIN (
          SELECT
            purchase_order_item_id,
            SUM(received_quantity)::numeric AS received_quantity
          FROM portal.receipt_voucher_items
          WHERE purchase_order_item_id = ANY($2::bigint[])
          GROUP BY purchase_order_item_id
        ) received
          ON received.purchase_order_item_id = poi.id
        WHERE po.purchase_request_id = $1
        AND poi.id = ANY($2::bigint[])
        `,
        [purchaseRequestId, uniquePurchaseOrderItemIds],
      )

      if (
        purchaseOrderItemsResult.rows.length !== uniquePurchaseOrderItemIds.length
      ) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message:
            "One or more purchase order items do not belong to this purchase request",
        })
      }

      const incomingReceivedByOrderItem = normalizedItems.reduce(
        (acc, item) => {
          if (!item.purchase_order_item_id || !item.received_quantity) {
            return acc
          }

          acc[item.purchase_order_item_id] =
            (acc[item.purchase_order_item_id] ?? 0) + item.received_quantity

          return acc
        },
        {} as Record<number, number>,
      )

      const overReceivedItem = purchaseOrderItemsResult.rows.find((item) => {
        const incomingQuantity = incomingReceivedByOrderItem[Number(item.id)] ?? 0
        const orderedQuantity = Number(item.ordered_quantity || 0)
        const alreadyReceivedQuantity = Number(
          item.already_received_quantity || 0,
        )

        return incomingQuantity + alreadyReceivedQuantity > orderedQuantity
      })

      if (overReceivedItem) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message:
            "One or more received quantities exceed the ordered quantity",
        })
      }
    }

    const sequenceResult = await client.query(
      `
      SELECT COALESCE(MAX(receipt_voucher_sequence), 0) + 1 AS next_sequence
      FROM portal.receipt_vouchers
      WHERE purchase_request_id = $1
      `,
      [purchaseRequestId],
    )

    const receiptVoucherSequence = Number(sequenceResult.rows[0].next_sequence)
    const receiptVoucherReference = formatReceiptVoucherReference(
      requestReference,
      receiptVoucherSequence,
    )

    const voucherResult = await client.query(
      `
      INSERT INTO portal.receipt_vouchers (
        purchase_request_id,
        receipt_voucher_reference,
        receipt_voucher_sequence,
        received_by_user_id,
        received_at,
        receipt_note,
        status
      )
      VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6, 'received')
      RETURNING *
      `,
      [
        purchaseRequestId,
        receiptVoucherReference,
        receiptVoucherSequence,
        receivedByUserId,
        received_at || null,
        cleanText(receipt_note),
      ],
    )

    let receiptVoucher = voucherResult.rows[0]

    const insertedItems = []

    for (const item of normalizedItems) {
      const itemResult = await client.query(
        `
        INSERT INTO portal.receipt_voucher_items (
          receipt_voucher_id,
          purchase_request_item_id,
          purchase_order_item_id,
          quantity,
          received_quantity,
          comment
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        `,
        [
          receiptVoucher.id,
          item.purchase_request_item_id,
          item.purchase_order_item_id,
          item.quantity,
          item.received_quantity,
          item.comment,
        ],
      )

      insertedItems.push(itemResult.rows[0])
    }

    const receiptProgressResult = await client.query(
      `
      SELECT
        COALESCE(ordered.ordered_total_quantity, 0)::numeric
          AS ordered_total_quantity,
        COALESCE(received.received_total_quantity, 0)::numeric
          AS received_total_quantity
      FROM (
        SELECT
          COALESCE(SUM(poi.ordered_quantity), 0)::numeric
            AS ordered_total_quantity
        FROM portal.purchase_orders po
        INNER JOIN portal.purchase_order_items poi
          ON poi.purchase_order_id = po.id
        WHERE po.purchase_request_id = $1
      ) ordered
      CROSS JOIN (
        SELECT
          COALESCE(SUM(rvi.received_quantity), 0)::numeric
            AS received_total_quantity
        FROM portal.receipt_vouchers rv
        INNER JOIN portal.receipt_voucher_items rvi
          ON rvi.receipt_voucher_id = rv.id
        WHERE rv.purchase_request_id = $1
      ) received
      `,
      [purchaseRequestId],
    )

    const orderedTotalQuantity = Number(
      receiptProgressResult.rows[0]?.ordered_total_quantity || 0,
    )
    const receivedTotalQuantity = Number(
      receiptProgressResult.rows[0]?.received_total_quantity || 0,
    )
    const nextRequestStatus =
      orderedTotalQuantity > 0 && receivedTotalQuantity >= orderedTotalQuantity
        ? "received"
        : "partially_received"

    const updatedRequestResult = await client.query(
      `
      UPDATE portal.purchase_requests
      SET status = $2
      WHERE id = $1
      RETURNING *
      `,
      [purchaseRequestId, nextRequestStatus],
    )

    const receiptVoucherPdfData = await getReceiptVoucherPdfData(
      client,
      receiptVoucher.id,
    )

    if (!receiptVoucherPdfData) {
      await client.query("ROLLBACK")

      return res.status(404).json({
        message: "Receipt voucher not found",
      })
    }

    const receiptVoucherPdfKey = createReceiptVoucherPdfKey(
      receiptVoucher.id,
      receiptVoucher.receipt_voucher_reference,
    )
    const receiptVoucherPdfFilename = createReceiptVoucherPdfFilename(
      receiptVoucher.receipt_voucher_reference,
    )
    const receiptVoucherPdfBytes = await generateReceiptVoucherPdf(
      receiptVoucherPdfData,
    )

    await uploadBufferToS3({
      key: receiptVoucherPdfKey,
      buffer: Buffer.from(receiptVoucherPdfBytes),
      contentType: "application/pdf",
    })

    const receiptVoucherWithDocumentResult = await client.query(
      `
      UPDATE portal.receipt_vouchers
      SET receipt_document_keys = $1
      WHERE id = $2
      RETURNING *
      `,
      [[receiptVoucherPdfKey], receiptVoucher.id],
    )

    receiptVoucher = receiptVoucherWithDocumentResult.rows[0]

    const receiptVoucherPdfPreviewUrl = await getSignedUrlForKey(
      receiptVoucherPdfKey,
      {
        expiresIn: 60 * 60,
        responseContentDisposition: createPdfPreviewDisposition(
          receiptVoucherPdfFilename,
        ),
        responseContentType: "application/pdf",
      },
    )

    const receiptVoucherPdfDownloadUrl = await getSignedUrlForKey(
      receiptVoucherPdfKey,
      {
        expiresIn: 60 * 60,
        responseContentDisposition: createPdfDownloadDisposition(
          receiptVoucherPdfFilename,
        ),
        responseContentType: "application/pdf",
      },
    )

    await client.query("COMMIT")

    return res.status(201).json({
      purchase_request: updatedRequestResult.rows[0],
      receipt_voucher: receiptVoucher,
      items: insertedItems,
      ordered_total_quantity: orderedTotalQuantity,
      received_total_quantity: receivedTotalQuantity,
      has_receivable_items: receivedTotalQuantity < orderedTotalQuantity,
      receipt_voucher_pdf_urls: [receiptVoucherPdfPreviewUrl],
      receipt_voucher_pdf_preview_urls: [receiptVoucherPdfPreviewUrl],
      receipt_voucher_pdf_download_urls: [receiptVoucherPdfDownloadUrl],
      receipt_voucher_pdf: {
        key: receiptVoucherPdfKey,
        url: receiptVoucherPdfPreviewUrl,
        preview_url: receiptVoucherPdfPreviewUrl,
        download_url: receiptVoucherPdfDownloadUrl,
      },
    })
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)

    console.error("Create receipt voucher error:", error)

    return res.status(500).json({
      message: "Unable to create receipt voucher",
    })
  } finally {
    client.release()
  }
})

export default router
