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
import { authMiddleware } from "../../middleware/auth"

const router = express.Router()

type ReceiptVoucherItemInput = {
  id?: number | null
  purchase_request_item_id?: number | null
  purchase_order_item_id?: number | null
  quantity?: number | string | null
  received_quantity?: number | string | null
  comment?: string | null
}

type NormalizedReceiptVoucherUpdateItem = NormalizedReceiptVoucherItem & {
  id: number | null
}

type NormalizedReceiptVoucherItem = {
  purchase_request_item_id: number | null
  purchase_order_item_id: number | null
  quantity: number | null
  received_quantity: number | null
  comment: string | null
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

  await client.query(`
    ALTER TABLE portal.receipt_vouchers
    ADD COLUMN IF NOT EXISTS supplier_name text,
    ADD COLUMN IF NOT EXISTS supplier_address_snapshot text,
    ADD COLUMN IF NOT EXISTS supplier_phone text,
    ADD COLUMN IF NOT EXISTS delivery_method text
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

const getReferenceBaseFromRequest = (requestReference: string) => {
  const match = requestReference.match(/^req-(\d{2})-(\d{1,2})-(\d{2,})$/)

  if (!match) {
    throw new Error(`Invalid purchase request reference: ${requestReference}`)
  }

  const [, shortYear, month, sequence] = match

  return `${shortYear}-${month}-${sequence}`
}

const formatReceiptVoucherReference = ({
  requestReference,
  receiptVoucherSequence,
  purchaseOrderSubsequence,
  hasMultiplePurchaseOrders,
}: {
  requestReference: string
  receiptVoucherSequence: number
  purchaseOrderSubsequence: number | null
  hasMultiplePurchaseOrders: boolean
}) => {
  const baseReference = getReferenceBaseFromRequest(requestReference)

  if (hasMultiplePurchaseOrders && purchaseOrderSubsequence !== null) {
    return `br-${baseReference}-${purchaseOrderSubsequence}-${receiptVoucherSequence}`
  }

  return `br-${baseReference}-${receiptVoucherSequence}`
}

const getReceiptVoucherPdfData = async (
  client: PoolClient,
  receiptVoucherId: number,
) => {
  const voucherResult = await client.query(
    `
    SELECT
      rv.*,
      pr.request_reference
    FROM portal.receipt_vouchers rv
    INNER JOIN portal.purchase_requests pr
      ON pr.id = rv.purchase_request_id
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
      po.purchase_order_reference,
      po.supplier_name AS purchase_order_supplier_name,
      po.supplier_address_snapshot AS purchase_order_supplier_address_snapshot,
      po.supplier_phone AS purchase_order_supplier_phone,
      po.delivery_method AS purchase_order_delivery_method
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

  const firstPurchaseOrderBackedItem = itemsResult.rows.find(
    (item) =>
      item.purchase_order_supplier_name ||
      item.purchase_order_supplier_address_snapshot ||
      item.purchase_order_supplier_phone ||
      item.purchase_order_delivery_method,
  )

  return {
    ...voucherResult.rows[0],
    supplier_name:
      voucherResult.rows[0].supplier_name ??
      firstPurchaseOrderBackedItem?.purchase_order_supplier_name ??
      null,
    supplier_address_snapshot:
      voucherResult.rows[0].supplier_address_snapshot ??
      firstPurchaseOrderBackedItem?.purchase_order_supplier_address_snapshot ??
      null,
    supplier_phone:
      voucherResult.rows[0].supplier_phone ??
      firstPurchaseOrderBackedItem?.purchase_order_supplier_phone ??
      null,
    delivery_method:
      voucherResult.rows[0].delivery_method ??
      firstPurchaseOrderBackedItem?.purchase_order_delivery_method ??
      null,
    purchase_order_references: purchaseOrderReferences,
    items: itemsResult.rows,
  }
}

router.get("/debug/pdf-preview", async (_req, res) => {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ENABLE_RECEIPT_VOUCHER_PDF_PREVIEW !== "true"
  ) {
    return res.status(404).json({ message: "Receipt voucher preview not found" })
  }

  try {
    const pdfBytes = await generateReceiptVoucherPdf({
      receipt_voucher_reference: "DA-2026-0042-R01",
      supplier_name: "Ferme Exemple Inc.",
      supplier_address_snapshot:
        "123 Rang des Legumes\nSainte-Sophie, Quebec, J5J 1A1",
      supplier_phone: "450-555-0198",
      delivery_method: "Livraison fournisseur",
      received_at: "2026-06-29",
      received_by_name: "Ricardo Molière",
      received_by_email: "achats@vegibec.com",
      buyer_phone: "450-596-0566",
      items: [
        {
          item_code: "CAR-10LB",
          item_description: "Carottes orange lavees format 10 lb",
          quantity: 120,
          received_quantity: 120,
          ordered_unit: "caisse",
          comment: "OK",
        },
        {
          item_code: "PAT-YUKON-50",
          item_description:
            "Pommes de terre Yukon Gold calibre moyen sac de 50 lb",
          quantity: 80,
          received_quantity: 76,
          ordered_unit: "sac",
          comment: "4 manquants",
        },
        {
          item_code: "OIGN-JAUNE-25",
          item_description: "Oignons jaunes emballage 25 lb",
          quantity: 40,
          received_quantity: 40,
          ordered_unit: "sac",
          comment: "Palette B",
        },
        {
          item_code: "CEL-24",
          item_description:
            "Celeri frais caisse de 24 unites avec description volontairement longue",
          quantity: 25,
          received_quantity: 25,
          ordered_unit: "caisse",
          comment: "Froid",
        },
      ],
    })

    res.setHeader("Content-Type", "application/pdf")
    res.setHeader(
      "Content-Disposition",
      'inline; filename="receipt-voucher-debug-preview.pdf"',
    )

    return res.send(Buffer.from(pdfBytes))
  } catch (error) {
    console.error("Receipt voucher PDF preview error:", error)

    return res.status(500).json({
      message: "Receipt voucher PDF preview generation failed",
    })
  }
})

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

    const shouldDownload =
      req.query.download === "1" || req.query.download === "true"

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

router.patch("/:receiptVoucherId", authMiddleware, async (req, res) => {
  const client = await pool.connect()
  let transactionStarted = false

  try {
    const receiptVoucherId = toPositiveInteger(req.params.receiptVoucherId)
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    const receivedByName = cleanText(req.body?.received_by_name)

    if (!receiptVoucherId || !receivedByName || items.length === 0) {
      return res.status(400).json({
        message: "Le réceptionnaire et au moins un article sont requis.",
      })
    }

    const normalizedItems: NormalizedReceiptVoucherUpdateItem[] = items.map(
      (item: ReceiptVoucherItemInput) => ({
        id: toPositiveInteger(item.id),
        purchase_request_item_id: toPositiveInteger(
          item.purchase_request_item_id,
        ),
        purchase_order_item_id: toPositiveInteger(item.purchase_order_item_id),
        quantity: toPositiveNumber(item.quantity),
        received_quantity: toPositiveNumber(item.received_quantity),
        comment: cleanText(item.comment),
      }),
    )

    if (
      normalizedItems.some(
        (item) =>
          !item.purchase_request_item_id ||
          !item.purchase_order_item_id ||
          !item.received_quantity,
      )
    ) {
      return res.status(400).json({
        message: "Chaque article doit avoir une quantité reçue valide.",
      })
    }

    const purchaseOrderItemIds = normalizedItems.map(
      (item) => item.purchase_order_item_id!,
    )
    if (new Set(purchaseOrderItemIds).size !== purchaseOrderItemIds.length) {
      return res.status(400).json({
        message: "Un article ne peut apparaître qu'une seule fois.",
      })
    }

    await client.query("BEGIN")
    transactionStarted = true

    const voucherResult = await client.query(
      `
      SELECT rv.id, rv.purchase_request_id, pr.status AS purchase_request_status
      FROM portal.receipt_vouchers rv
      INNER JOIN portal.purchase_requests pr
        ON pr.id = rv.purchase_request_id
      WHERE rv.id = $1
      FOR UPDATE OF rv, pr
      `,
      [receiptVoucherId],
    )

    if (voucherResult.rows.length === 0) {
      await client.query("ROLLBACK")
      transactionStarted = false
      return res.status(404).json({ message: "Receipt voucher not found" })
    }

    const purchaseRequestId = Number(voucherResult.rows[0].purchase_request_id)
    if (["cancelled", "rejected"].includes(voucherResult.rows[0].purchase_request_status)) {
      await client.query("ROLLBACK")
      transactionStarted = false
      return res.status(409).json({
        message: "Ce bon de réception appartient à une demande fermée.",
      })
    }

    const existingItemsResult = await client.query(
      `
      SELECT rvi.id, rvi.purchase_order_item_id, poi.purchase_order_id
      FROM portal.receipt_voucher_items rvi
      LEFT JOIN portal.purchase_order_items poi
        ON poi.id = rvi.purchase_order_item_id
      WHERE rvi.receipt_voucher_id = $1
      FOR UPDATE OF rvi
      `,
      [receiptVoucherId],
    )
    const existingItemsById = new Map(
      existingItemsResult.rows.map((item) => [Number(item.id), item]),
    )
    const existingPurchaseOrderIds = new Set(
      existingItemsResult.rows
        .map((item) => Number(item.purchase_order_id))
        .filter((id) => Number.isInteger(id) && id > 0),
    )

    const orderItemsResult = await client.query(
      `
      SELECT
        poi.id,
        poi.purchase_request_item_id,
        poi.purchase_order_id,
        poi.ordered_quantity,
        COALESCE(other_receipts.received_quantity, 0)::numeric
          AS received_by_other_vouchers
      FROM portal.purchase_order_items poi
      INNER JOIN portal.purchase_orders po
        ON po.id = poi.purchase_order_id
      LEFT JOIN (
        SELECT purchase_order_item_id, SUM(received_quantity)::numeric AS received_quantity
        FROM portal.receipt_voucher_items
        WHERE receipt_voucher_id <> $2
        GROUP BY purchase_order_item_id
      ) other_receipts
        ON other_receipts.purchase_order_item_id = poi.id
      WHERE po.purchase_request_id = $1
        AND poi.id = ANY($3::bigint[])
      FOR UPDATE OF poi
      `,
      [purchaseRequestId, receiptVoucherId, purchaseOrderItemIds],
    )
    const orderItemsById = new Map(
      orderItemsResult.rows.map((item) => [Number(item.id), item]),
    )

    if (orderItemsById.size !== purchaseOrderItemIds.length) {
      await client.query("ROLLBACK")
      transactionStarted = false
      return res.status(400).json({
        message: "Un ou plusieurs articles ne font pas partie de cette demande.",
      })
    }

    const submittedPurchaseOrderIds = new Set(
      orderItemsResult.rows.map((item) => Number(item.purchase_order_id)),
    )
    if (
      submittedPurchaseOrderIds.size !== 1 ||
      (existingPurchaseOrderIds.size > 0 &&
        !existingPurchaseOrderIds.has([...submittedPurchaseOrderIds][0]))
    ) {
      await client.query("ROLLBACK")
      transactionStarted = false
      return res.status(400).json({
        message:
          "Un bon de réception ne peut contenir que les articles d'un même bon de commande.",
      })
    }

    const submittedItemIds: number[] = []
    for (const item of normalizedItems) {
      const orderItem = orderItemsById.get(item.purchase_order_item_id!)
      const orderedQuantity = Number(orderItem.ordered_quantity)
      const receivedByOtherVouchers = Number(
        orderItem.received_by_other_vouchers,
      )

      if (
        Number(orderItem.purchase_request_item_id) !==
          item.purchase_request_item_id ||
        item.received_quantity! + receivedByOtherVouchers > orderedQuantity
      ) {
        await client.query("ROLLBACK")
        transactionStarted = false
        return res.status(400).json({
          message:
            "La quantité reçue dépasse la quantité commandée pour un ou plusieurs articles.",
        })
      }

      if (item.id) {
        const existingItem = existingItemsById.get(item.id)
        if (
          !existingItem ||
          Number(existingItem.purchase_order_item_id) !==
            item.purchase_order_item_id
        ) {
          await client.query("ROLLBACK")
          transactionStarted = false
          return res.status(400).json({
            message: "Un article du bon de réception est invalide.",
          })
        }

        await client.query(
          `
          UPDATE portal.receipt_voucher_items
          SET
            purchase_request_item_id = $3,
            quantity = $4,
            received_quantity = $5,
            comment = $6,
            updated_at = now()
          WHERE id = $1 AND receipt_voucher_id = $2
          `,
          [
            item.id,
            receiptVoucherId,
            item.purchase_request_item_id,
            orderedQuantity,
            item.received_quantity,
            item.comment,
          ],
        )
        submittedItemIds.push(item.id)
      } else {
        const insertedItem = await client.query(
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
          RETURNING id
          `,
          [
            receiptVoucherId,
            item.purchase_request_item_id,
            item.purchase_order_item_id,
            orderedQuantity,
            item.received_quantity,
            item.comment,
          ],
        )
        submittedItemIds.push(Number(insertedItem.rows[0].id))
      }
    }

    await client.query(
      `
      DELETE FROM portal.receipt_voucher_items
      WHERE receipt_voucher_id = $1
        AND NOT (id = ANY($2::bigint[]))
      `,
      [receiptVoucherId, submittedItemIds],
    )

    const receivedAt = cleanText(req.body?.received_at)
    if (receivedAt && Number.isNaN(new Date(receivedAt).getTime())) {
      await client.query("ROLLBACK")
      transactionStarted = false
      return res.status(400).json({ message: "La date de réception est invalide." })
    }

    const updatedVoucherResult = await client.query(
      `
      UPDATE portal.receipt_vouchers
      SET
        received_by_name = $2,
        received_by_email = $3,
        buyer_phone = $4,
        received_at = COALESCE($5::timestamptz, received_at),
        receipt_note = $6,
        supplier_name = $7,
        supplier_address_snapshot = $8,
        supplier_phone = $9,
        delivery_method = $10,
        updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [
        receiptVoucherId,
        receivedByName,
        cleanText(req.body?.received_by_email),
        cleanText(req.body?.buyer_phone),
        receivedAt,
        cleanText(req.body?.receipt_note),
        cleanText(req.body?.supplier_name),
        cleanText(req.body?.supplier_address_snapshot),
        cleanText(req.body?.supplier_phone),
        cleanText(req.body?.delivery_method),
      ],
    )

    const totalsResult = await client.query(
      `
      SELECT
        COALESCE(requested.total, 0)::numeric AS requested_total,
        COALESCE(ordered.total, 0)::numeric AS ordered_total,
        COALESCE(received.total, 0)::numeric AS received_total
      FROM (
        SELECT SUM(quantity)::numeric AS total
        FROM portal.purchase_request_items
        WHERE purchase_request_id = $1
      ) requested
      CROSS JOIN (
        SELECT SUM(poi.ordered_quantity)::numeric AS total
        FROM portal.purchase_orders po
        INNER JOIN portal.purchase_order_items poi ON poi.purchase_order_id = po.id
        WHERE po.purchase_request_id = $1
      ) ordered
      CROSS JOIN (
        SELECT SUM(rvi.received_quantity)::numeric AS total
        FROM portal.receipt_vouchers rv
        INNER JOIN portal.receipt_voucher_items rvi ON rvi.receipt_voucher_id = rv.id
        WHERE rv.purchase_request_id = $1
      ) received
      `,
      [purchaseRequestId],
    )
    const totals = totalsResult.rows[0]
    const requestedTotal = Number(totals.requested_total)
    const orderedTotal = Number(totals.ordered_total)
    const receivedTotal = Number(totals.received_total)
    const nextRequestStatus =
      requestedTotal > 0 &&
      orderedTotal >= requestedTotal &&
      receivedTotal >= orderedTotal
        ? "received"
        : "partially_received"

    await client.query(
      `UPDATE portal.purchase_requests SET status = $2, updated_at = now() WHERE id = $1`,
      [purchaseRequestId, nextRequestStatus],
    )

    await client.query("COMMIT")
    transactionStarted = false

    return res.json({
      receipt_voucher: updatedVoucherResult.rows[0],
      status: nextRequestStatus,
    })
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined)
    }
    console.error("Update receipt voucher error:", error)
    return res.status(500).json({ message: "Unable to update receipt voucher" })
  } finally {
    client.release()
  }
})

// router.get("/:receiptVoucherId/pdf-links", async (req, res) => {
//   const client = await pool.connect()

//   try {
//     const receiptVoucherId = Number(req.params.receiptVoucherId)

//     if (!Number.isInteger(receiptVoucherId) || receiptVoucherId <= 0) {
//       return res.status(400).json({ message: "Invalid receipt voucher id" })
//     }

//     await ensureReceiptVoucherDocumentColumn(client)

//     const voucherResult = await client.query(
//       `
//       SELECT id, receipt_voucher_reference, receipt_document_keys
//       FROM portal.receipt_vouchers
//       WHERE id = $1
//       `,
//       [receiptVoucherId],
//     )

//     if (voucherResult.rows.length === 0) {
//       return res.status(404).json({ message: "Receipt voucher not found" })
//     }

//     const links = await getReceiptVoucherPdfLinks(voucherResult.rows[0])

//     return res.json({
//       receipt_voucher_id: voucherResult.rows[0].id,
//       receipt_voucher_reference:
//         voucherResult.rows[0].receipt_voucher_reference,
//       receipt_voucher_pdf_links: links,
//       receipt_voucher_pdf:
//         links.length > 0
//           ? {
//               key: links[0].key,
//               url: links[0].preview_url,
//               preview_url: links[0].preview_url,
//               download_url: links[0].download_url,
//             }
//           : null,
//     })
//   } catch (error) {
//     console.error("Error getting receipt voucher PDF links:", error)

//     return res.status(500).json({
//       message: "Error getting receipt voucher PDF links",
//     })
//   } finally {
//     client.release()
//   }
// })

router.post(["/", "/:id/:token", "/:id/reception/:token"], async (req, res) => {
  const client = await pool.connect()

  try {
   const {
  purchase_request_id,
  received_by_name,
  received_by_email,
  buyer_phone,
  received_at,
  receipt_note,
  supplier_name,
  supplier_address_snapshot,
  supplier_phone,
  delivery_method,
  items,
} = req.body ?? {}

    const purchaseRequestId =
      toPositiveInteger(req.params.id) || toPositiveInteger(purchase_request_id)
   const receivedByName = cleanText(received_by_name)
const receivedByEmail = cleanText(received_by_email)
const buyerPhone = cleanText(buyer_phone)
const requestedSupplierName = cleanText(supplier_name)
const requestedSupplierAddressSnapshot = cleanText(supplier_address_snapshot)
const requestedSupplierPhone = cleanText(supplier_phone)
const requestedDeliveryMethod = cleanText(delivery_method)

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

  if (!receivedByName) {
  return res.status(400).json({
    message: "received_by_name is required",
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
      (item) => !item.purchase_request_item_id,
    )

    if (invalidItem) {
      return res.status(400).json({
        message: "Each item needs purchase_request_item_id",
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

    if (
      requestStatus !== "purchased" &&
      requestStatus !== "partially_purchased" &&
      requestStatus !== "partially_received"
    ) {
      await client.query("ROLLBACK")

      return res.status(400).json({
        message: "This purchase request is not ready to receive",
      })
    }

    const itemIds = [
      ...new Set(
        normalizedItems
          .map((item) => item.purchase_request_item_id)
          .filter((id): id is number => !!id),
      ),
    ]

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

    const requestedPurchaseOrderItemIds = normalizedItems
      .map((item) => item.purchase_order_item_id)
      .filter((id): id is number => !!id)
    const uniqueRequestedPurchaseOrderItemIds = [
      ...new Set(requestedPurchaseOrderItemIds),
    ]

    const purchaseOrderItemsResult = await client.query(
      `
      SELECT
        poi.id,
        poi.purchase_request_item_id,
        poi.purchase_order_id,
        poi.ordered_quantity,
        poi.item_code,
        poi.item_description,
        poi.ordered_unit,
        po.purchase_order_reference,
        po.supplier_id,
        po.supplier,
        po.supplier_name,
        po.supplier_address_snapshot,
        po.supplier_phone,
        po.delivery_method,
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
        WHERE purchase_order_item_id IS NOT NULL
        GROUP BY purchase_order_item_id
      ) received
        ON received.purchase_order_item_id = poi.id
      WHERE po.purchase_request_id = $1
      AND (
        poi.purchase_request_item_id = ANY($2::bigint[])
        OR (
          CARDINALITY($3::bigint[]) > 0
          AND poi.id = ANY($3::bigint[])
        )
      )
      `,
      [purchaseRequestId, itemIds, uniqueRequestedPurchaseOrderItemIds],
    )

    const purchaseOrderItemsById = new Map<number, any>()
    const purchaseOrderItemsByRequestItemId = new Map<number, any[]>()

    purchaseOrderItemsResult.rows.forEach((item) => {
      const purchaseOrderItemId = Number(item.id)
      const purchaseRequestItemId = Number(item.purchase_request_item_id)

      purchaseOrderItemsById.set(purchaseOrderItemId, item)

      const itemsForRequestItem =
        purchaseOrderItemsByRequestItemId.get(purchaseRequestItemId) ?? []

      itemsForRequestItem.push(item)
      purchaseOrderItemsByRequestItemId.set(
        purchaseRequestItemId,
        itemsForRequestItem,
      )
    })

    const invalidPurchaseOrderItem = uniqueRequestedPurchaseOrderItemIds.find(
      (id) => !purchaseOrderItemsById.has(id),
    )

    if (invalidPurchaseOrderItem) {
      await client.query("ROLLBACK")

      return res.status(400).json({
        message:
          "One or more purchase order items do not belong to this purchase request",
      })
    }

    const hydratedItems: NormalizedReceiptVoucherItem[] = []

    for (const item of normalizedItems) {
      let purchaseOrderItem = item.purchase_order_item_id
        ? purchaseOrderItemsById.get(item.purchase_order_item_id)
        : null

      if (
        purchaseOrderItem &&
        Number(purchaseOrderItem.purchase_request_item_id) !==
          item.purchase_request_item_id
      ) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message:
            "One or more purchase order items do not match the purchase request item",
        })
      }

      if (!purchaseOrderItem) {
        const matchingPurchaseOrderItems =
          purchaseOrderItemsByRequestItemId.get(item.purchase_request_item_id!) ??
          []

        const receivablePurchaseOrderItems = matchingPurchaseOrderItems.filter(
          (orderItem) => {
            const orderedQuantity = Number(orderItem.ordered_quantity || 0)
            const alreadyReceivedQuantity = Number(
              orderItem.already_received_quantity || 0,
            )

            return orderedQuantity > alreadyReceivedQuantity
          },
        )

        if (receivablePurchaseOrderItems.length === 1) {
          purchaseOrderItem = receivablePurchaseOrderItems[0]
        }
      }

      const orderedQuantity = purchaseOrderItem
        ? Number(purchaseOrderItem.ordered_quantity || 0)
        : null
      const alreadyReceivedQuantity = purchaseOrderItem
        ? Number(purchaseOrderItem.already_received_quantity || 0)
        : 0
      const remainingQuantity =
        orderedQuantity === null
          ? null
          : Math.max(orderedQuantity - alreadyReceivedQuantity, 0)

      hydratedItems.push({
        ...item,
        purchase_order_item_id: purchaseOrderItem
          ? Number(purchaseOrderItem.id)
          : item.purchase_order_item_id,
        quantity: orderedQuantity ?? item.quantity,
        received_quantity: item.received_quantity ?? remainingQuantity,
      })
    }

    const invalidQuantityItem = hydratedItems.find(
      (item) => !item.quantity || !item.received_quantity,
    )

    if (invalidQuantityItem) {
      await client.query("ROLLBACK")

      return res.status(400).json({
        message:
          "Each item needs quantity and received_quantity unless it is linked to a receivable purchase order item",
      })
    }

    const purchaseOrderItemIds = hydratedItems
      .map((item) => item.purchase_order_item_id)
      .filter((id): id is number => !!id)
    const uniquePurchaseOrderItemIds = [...new Set(purchaseOrderItemIds)]

    if (uniquePurchaseOrderItemIds.length > 0) {
      const incomingReceivedByOrderItem: Record<number, number> = {}

      hydratedItems.forEach((item) => {
        if (!item.purchase_order_item_id || !item.received_quantity) {
          return
        }

        incomingReceivedByOrderItem[item.purchase_order_item_id] =
          (incomingReceivedByOrderItem[item.purchase_order_item_id] ?? 0) +
          item.received_quantity
      })

      const overReceivedItem = uniquePurchaseOrderItemIds
        .map((id) => purchaseOrderItemsById.get(id))
        .find((item) => {
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
            "La quantité reçue dépasse la quantité restante pour un ou plusieurs articles.",
        })
      }
    }

    const linkedPurchaseOrderItems = uniquePurchaseOrderItemIds
      .map((id) => purchaseOrderItemsById.get(id))
      .filter(Boolean)

    const firstPurchaseOrderItem = linkedPurchaseOrderItems[0] ?? null

    const receiptSupplierName =
      requestedSupplierName ?? firstPurchaseOrderItem?.supplier_name ?? null
    const receiptSupplierAddressSnapshot =
      requestedSupplierAddressSnapshot ??
      firstPurchaseOrderItem?.supplier_address_snapshot ??
      null
    const receiptSupplierPhone =
      requestedSupplierPhone ?? firstPurchaseOrderItem?.supplier_phone ?? null
    const receiptDeliveryMethod =
      requestedDeliveryMethod ?? firstPurchaseOrderItem?.delivery_method ?? null

  const purchaseOrderCountResult = await client.query(
  `
  SELECT COUNT(*)::int AS purchase_order_count
  FROM portal.purchase_orders
  WHERE purchase_request_id = $1
  `,
  [purchaseRequestId],
)

const purchaseOrderCount = Number(
  purchaseOrderCountResult.rows[0]?.purchase_order_count || 0,
)

const hasMultiplePurchaseOrders = purchaseOrderCount > 1

const linkedPurchaseOrderIds = [
  ...new Set(
    linkedPurchaseOrderItems
      .map((item) => Number(item.purchase_order_id))
      .filter((id) => Number.isInteger(id) && id > 0),
  ),
]

if (linkedPurchaseOrderIds.length > 1) {
  await client.query("ROLLBACK")

  return res.status(400).json({
    message:
      "A receipt voucher can only be created for one purchase order at a time",
  })
}

const linkedPurchaseOrderId = linkedPurchaseOrderIds[0] ?? null

let purchaseOrderSubsequence: number | null = null

if (hasMultiplePurchaseOrders) {
  if (linkedPurchaseOrderId === null) {
    await client.query("ROLLBACK")

    return res.status(400).json({
      message: "A purchase order item is required for this receipt voucher",
    })
  }

  const purchaseOrderOrdinalResult = await client.query(
    `
    SELECT purchase_order_ordinal
    FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          ORDER BY
            purchase_order_sequence ASC,
            purchase_order_subsequence ASC NULLS FIRST,
            id ASC
        )::int AS purchase_order_ordinal
      FROM portal.purchase_orders
      WHERE purchase_request_id = $1
    ) purchase_order_positions
    WHERE id = $2
    `,
    [purchaseRequestId, linkedPurchaseOrderId],
  )

  purchaseOrderSubsequence = Number(
    purchaseOrderOrdinalResult.rows[0]?.purchase_order_ordinal || 0,
  )

  if (!purchaseOrderSubsequence) {
    await client.query("ROLLBACK")

    return res.status(400).json({
      message: "Unable to identify the purchase order for this receipt voucher",
    })
  }
}

await client.query(
  `
  SELECT pg_advisory_xact_lock(hashtext($1))
  `,
  [`portal.receipt_vouchers.request.${purchaseRequestId}`],
)

// receipt_vouchers_request_sequence_unique is scoped to the purchase request,
// so the sequence must be allocated globally across all of its purchase orders.
const sequenceResult = await client.query(
  `
  SELECT COALESCE(MAX(receipt_voucher_sequence), 0) + 1 AS next_sequence
  FROM portal.receipt_vouchers
  WHERE purchase_request_id = $1
  `,
  [purchaseRequestId],
)

const receiptVoucherSequence = Number(sequenceResult.rows[0].next_sequence)

let receiptVoucherReferenceSequence = receiptVoucherSequence

if (hasMultiplePurchaseOrders && linkedPurchaseOrderId !== null) {
  const referenceSequenceResult = await client.query(
    `
    SELECT COUNT(DISTINCT rv.id)::int + 1 AS next_sequence
    FROM portal.receipt_vouchers rv
    INNER JOIN portal.receipt_voucher_items rvi
      ON rvi.receipt_voucher_id = rv.id
    INNER JOIN portal.purchase_order_items poi
      ON poi.id = rvi.purchase_order_item_id
    WHERE rv.purchase_request_id = $1
      AND poi.purchase_order_id = $2
    `,
    [purchaseRequestId, linkedPurchaseOrderId],
  )

  receiptVoucherReferenceSequence = Number(
    referenceSequenceResult.rows[0].next_sequence,
  )
}

const receiptVoucherReference = formatReceiptVoucherReference({
  requestReference,
  receiptVoucherSequence: receiptVoucherReferenceSequence,
  purchaseOrderSubsequence,
  hasMultiplePurchaseOrders,
})

const voucherResult = await client.query(
  `
  INSERT INTO portal.receipt_vouchers (
    purchase_request_id,
    receipt_voucher_reference,
    receipt_voucher_sequence,
    received_by_name,
    received_by_email,
    buyer_phone,
    received_at,
    receipt_note,
    supplier_name,
    supplier_address_snapshot,
    supplier_phone,
    delivery_method,
    status
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8,
    $9, $10, $11, $12, 'received'
  )
  RETURNING *
  `,
  [
    purchaseRequestId,
    receiptVoucherReference,
    receiptVoucherSequence,
    receivedByName,
    receivedByEmail,
    buyerPhone,
    received_at || null,
    cleanText(receipt_note),
    receiptSupplierName,
    receiptSupplierAddressSnapshot,
    receiptSupplierPhone,
    receiptDeliveryMethod,
  ],
)

    let receiptVoucher = voucherResult.rows[0]

    const insertedItems = []

    for (const item of hydratedItems) {
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

      const purchaseOrderItem = item.purchase_order_item_id
        ? purchaseOrderItemsById.get(item.purchase_order_item_id)
        : null

      insertedItems.push({
        ...itemResult.rows[0],
        item_code: purchaseOrderItem?.item_code ?? null,
        item_description: purchaseOrderItem?.item_description ?? null,
        ordered_unit: purchaseOrderItem?.ordered_unit ?? null,
        purchase_order_reference:
          purchaseOrderItem?.purchase_order_reference ?? null,
      })
    }

    const receiptProgressResult = await client.query(
      `
      SELECT
        COALESCE(requested.requested_total_quantity, 0)::numeric
          AS requested_total_quantity,
        COALESCE(ordered.ordered_total_quantity, 0)::numeric
          AS ordered_total_quantity,
        COALESCE(received.received_total_quantity, 0)::numeric
          AS received_total_quantity
      FROM (
        SELECT
          COALESCE(SUM(pri.quantity), 0)::numeric
            AS requested_total_quantity
        FROM portal.purchase_request_items pri
        WHERE pri.purchase_request_id = $1
      ) requested
      CROSS JOIN (
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

    const requestedTotalQuantity = Number(
      receiptProgressResult.rows[0]?.requested_total_quantity || 0,
    )
    const orderedTotalQuantity = Number(
      receiptProgressResult.rows[0]?.ordered_total_quantity || 0,
    )
    const receivedTotalQuantity = Number(
      receiptProgressResult.rows[0]?.received_total_quantity || 0,
    )
    const nextRequestStatus =
      requestedTotalQuantity > 0 &&
      orderedTotalQuantity >= requestedTotalQuantity &&
      receivedTotalQuantity >= orderedTotalQuantity
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
