import express from "express"
import { pool } from "../../db"

import { actionPurchaseRequestLimiter } from "../Portal/Utils/purchaseRequestLimiters"
import {
  buildReceiptVoucherUrl,
  getOrCreateActiveReceiptVoucherToken,
  getPurchaseTokenFromRequest,
  markPurchaseTokenUsed,
  validatePurchaseToken,
} from "./Utils/PurchaseHelper"
import { getPurchaseRequestWithItems } from "./PurchaseRequest"
import { generatePurchaseOrderPdf } from "./Utils/PdfPoGeneration"
import { getSignedUrlForKey, uploadBufferToS3 } from "../../services/s3.services"

const router = express.Router()

const cleanText = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }

  if (typeof value !== "string") return null

  const trimmed = value.trim()

  return trimmed === "" ? null : trimmed
}

const cleanNumber = (value: unknown) => {
  if (value === "" || value === undefined || value === null) return null

  const number = Number(value)

  return Number.isFinite(number) ? number : null
}

const cleanPositiveNumber = (value: unknown) => {
  const number = cleanNumber(value)

  if (number === null || number <= 0) return null

  return number
}

const cleanInteger = (value: unknown) => {
  const number = cleanNumber(value)

  if (number === null || !Number.isInteger(number)) return null

  return number
}

const cleanPositiveInteger = (value: unknown) => {
  const number = cleanInteger(value)

  if (number === null || number <= 0) return null

  return number
}

const cleanDate = (value: unknown) => {
  if (typeof value !== "string") return null

  const trimmed = value.trim()

  if (!trimmed) return null

  return trimmed
}

const getReferenceBaseFromRequest = (requestReference: string) => {
  const match = requestReference.match(/^req-(\d{2})-(\d{1,2})-(\d{2,})$/)

  if (!match) {
    throw new Error(`Invalid purchase request reference: ${requestReference}`)
  }

  const [, shortYear, month, sequence] = match

  return `${shortYear}-${month}-${sequence}`
}

const getRequestSequenceFromReference = (requestReference: string) => {
  const match = requestReference.match(/^req-(\d{2})-(\d{1,2})-(\d{2,})$/)

  if (!match) {
    throw new Error(`Invalid purchase request reference: ${requestReference}`)
  }

  return Number(match[3])
}

const formatPurchaseOrderReference = (
  requestReference: string,
  purchaseOrderSubsequence: number | null,
) => {
  const baseReference = getReferenceBaseFromRequest(requestReference)

  if (purchaseOrderSubsequence === null) {
    return `bc-${baseReference}`
  }

  return `bc-${baseReference}-${purchaseOrderSubsequence}`
}

const getOrderMonthKey = (dateValue: unknown) => {
  const cleanedDate = cleanDate(dateValue)
  const date = cleanedDate ? new Date(cleanedDate) : new Date()

  if (Number.isNaN(date.getTime())) {
    const fallbackDate = new Date()
    const year = fallbackDate.getFullYear()
    const month = String(fallbackDate.getMonth() + 1).padStart(2, "0")

    return `${year}-${month}`
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")

  return `${year}-${month}`
}

const createPurchaseOrderPdfKey = (purchaseOrderId: number, reference: string, language: "fr" | "en") => {
  const safeReference = reference.replace(/[^a-zA-Z0-9_-]/g, "-")

  return `portal/purchase-orders/${purchaseOrderId}/bon-commande-${safeReference}-${language}.pdf`
}

const createPurchaseOrderPdfFilename = (reference: string, language: "fr" | "en" = "fr") => {
  const safeReference = reference.replace(/[^a-zA-Z0-9_-]/g, "-")

  return `${language === "en" ? "purchase-order" : "bon-commande"}-${safeReference}.pdf`
}

const createPdfDownloadDisposition = (filename: string) => {
  return `attachment; filename="${filename}"`
}

const createPdfPreviewDisposition = (filename: string) => {
  return `inline; filename="${filename}"`
}

type PurchaseOrderItemPayload = {
  purchase_request_item_id?: unknown
  item_code?: unknown
  item_description?: unknown
  ordered_quantity?: unknown
  ordered_unit?: unknown
  number_of_pallets?: unknown
  final_unit_price?: unknown
  location?: unknown
}

router.patch("/purchase-orders/:purchaseOrderId", async (req, res) => {
  const client = await pool.connect()
  try {
    const purchaseOrderId = cleanPositiveInteger(req.params.purchaseOrderId)
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (!purchaseOrderId || items.length === 0) {
      return res.status(400).json({ message: "Invalid purchase order update" })
    }

    await client.query("BEGIN")
    const orderResult = await client.query(
      "SELECT id, purchase_request_id FROM portal.purchase_orders WHERE id = $1 FOR UPDATE",
      [purchaseOrderId],
    )
    if (!orderResult.rowCount) {
      await client.query("ROLLBACK")
      return res.status(404).json({ message: "Purchase order not found" })
    }

    const submittedItemIds: number[] = []
    for (const item of items) {
      const itemId = cleanPositiveInteger(item.id)
      const quantity = cleanPositiveNumber(item.quantity)
      const unitPrice = cleanNumber(item.ordered_unit_price)
      if (!itemId || !quantity || unitPrice === null || unitPrice < 0) {
        await client.query("ROLLBACK")
        return res.status(400).json({ message: "Invalid purchase order item" })
      }
      submittedItemIds.push(itemId)

      const updatedItem = await client.query(
        `UPDATE portal.purchase_order_items poi
         SET item_description = $3, ordered_quantity = $4,
             ordered_unit = $5, final_unit_price = $6, item_code = $7,
             updated_at = now()
         WHERE poi.id = $1 AND poi.purchase_order_id = $2
           AND $4 >= COALESCE((
             SELECT SUM(rvi.received_quantity)
             FROM portal.receipt_voucher_items rvi
             WHERE rvi.purchase_order_item_id = poi.id
           ), 0)
         RETURNING id`,
        [itemId, purchaseOrderId, cleanText(item.item_description), quantity,
          cleanText(item.ordered_unit), unitPrice, cleanText(item.item_code)],
      )
      if (!updatedItem.rowCount) {
        await client.query("ROLLBACK")
        return res.status(400).json({
          message: "An item is invalid or its quantity is below the quantity already received",
        })
      }
    }

    await client.query(
      `DELETE FROM portal.purchase_order_items poi
       WHERE poi.purchase_order_id = $1
         AND NOT (poi.id = ANY($2::int[]))
         AND NOT EXISTS (
           SELECT 1 FROM portal.receipt_voucher_items rvi
           WHERE rvi.purchase_order_item_id = poi.id
         )`,
      [purchaseOrderId, submittedItemIds],
    )

    const protectedRemovedItems = await client.query(
      `SELECT poi.id
       FROM portal.purchase_order_items poi
       WHERE poi.purchase_order_id = $1
         AND NOT (poi.id = ANY($2::int[]))`,
      [purchaseOrderId, submittedItemIds],
    )
    if (protectedRemovedItems.rowCount) {
      await client.query("ROLLBACK")
      return res.status(400).json({
        message: "An item that has already been received cannot be removed",
      })
    }

    const updatedOrder = await client.query(
      `UPDATE portal.purchase_orders SET
         supplier_name = $2, supplier_address_snapshot = $3, supplier_phone = $4,
         buyer_name = $5, buyer_email = $6, buyer_phone = $7,
         purchased_at = COALESCE($8::timestamptz, purchased_at),
         delivery_method = $9, shipping_address_snapshot = $10,
         currency_code = COALESCE($11, currency_code), purchase_note = $12,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [purchaseOrderId, cleanText(req.body.supplier_name),
        cleanText(req.body.supplier_address_snapshot), cleanText(req.body.supplier_phone),
        cleanText(req.body.buyer_name), cleanText(req.body.buyer_email),
        cleanText(req.body.buyer_phone), cleanDate(req.body.ordered_at),
        cleanText(req.body.delivery_method), cleanText(req.body.shipping_address_snapshot),
        cleanText(req.body.currency_code), cleanText(req.body.purchase_note)],
    )

    const purchaseRequestId = Number(orderResult.rows[0].purchase_request_id)
    await client.query(
      `UPDATE portal.purchase_requests pr
       SET status = CASE
         WHEN EXISTS (
           SELECT 1
           FROM portal.purchase_request_items pri
           LEFT JOIN (
             SELECT poi.purchase_request_item_id, SUM(poi.ordered_quantity)::numeric AS ordered_quantity
             FROM portal.purchase_order_items poi
             INNER JOIN portal.purchase_orders po ON po.id = poi.purchase_order_id
             WHERE po.purchase_request_id = pr.id
             GROUP BY poi.purchase_request_item_id
           ) ordered ON ordered.purchase_request_item_id = pri.id
           WHERE pri.purchase_request_id = pr.id
             AND COALESCE(ordered.ordered_quantity, 0) < pri.quantity
         ) THEN CASE
           WHEN EXISTS (SELECT 1 FROM portal.receipt_vouchers rv WHERE rv.purchase_request_id = pr.id)
             THEN 'partially_received'
           ELSE 'partially_purchased'
         END
         ELSE pr.status
       END
       WHERE pr.id = $1`,
      [purchaseRequestId],
    )
    await client.query("COMMIT")
    return res.json({ purchase_order: updatedOrder.rows[0] })
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    console.error("Error updating purchase order:", error)
    return res.status(500).json({ message: "Error updating purchase order" })
  } finally {
    client.release()
  }
})



router.get(["/purchase-orders/:purchaseOrderId/pdf", "/:purchaseOrderId/pdf"], async (req, res) => {
  const client = await pool.connect()

  try {
    const purchaseOrderId = Number(req.params.purchaseOrderId)

    if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
      return res.status(400).json({ message: "Invalid purchase order id" })
    }

    const purchaseOrderResult = await client.query(
      `
      SELECT
        po.*,
        COALESCE(po.supplier_phone, s.phone) AS supplier_phone
      FROM portal.purchase_orders po
      LEFT JOIN portal.suppliers s
        ON s.id = po.supplier_id
      WHERE po.id = $1
      `,
      [purchaseOrderId],
    )

    if (purchaseOrderResult.rows.length === 0) {
      return res.status(404).json({ message: "Purchase order not found" })
    }

    const itemsResult = await client.query(
      `
      SELECT *
      FROM portal.purchase_order_items
      WHERE purchase_order_id = $1
      ORDER BY id
      `,
      [purchaseOrderId],
    )

    const language = req.query.lang === "en" ? "en" : "fr"
    const pdfBytes = await generatePurchaseOrderPdf({
      ...purchaseOrderResult.rows[0],
      items: itemsResult.rows,
    }, language)

    const filename = createPurchaseOrderPdfFilename(
      purchaseOrderResult.rows[0].purchase_order_reference, language,
    )
    const shouldDownload =
      req.query.download === "1" || req.query.download === "true"

    res.setHeader("Content-Type", "application/pdf")
    res.setHeader(
      "Content-Disposition",
      shouldDownload
        ? createPdfDownloadDisposition(filename)
        : createPdfPreviewDisposition(filename),
    )

    return res.send(Buffer.from(pdfBytes))
  } catch (error) {
    console.error("Error generating purchase order PDF:", error)

    return res.status(500).json({
      message: "Error generating purchase order PDF",
    })
  } finally {
    client.release()
  }
})


router.get(
  ["/:id/:token", "/:id/acheter/:token"],
  actionPurchaseRequestLimiter,
  async (req, res) => {
    const client = await pool.connect()

    try {
      const { id } = req.params
      const purchaseRequestId = Number(id)

      if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
        return res.status(404).json({ message: "Purchase request not found" })
      }

      const purchaseToken = getPurchaseTokenFromRequest(req)

      const isPurchaseTokenValid = await validatePurchaseToken(
        client,
        purchaseRequestId,
        purchaseToken,
      )

      if (!isPurchaseTokenValid || !purchaseToken) {
        return res.status(403).json({
          message: "Le lien n'est plus valide",
        })
      }

      const purchaseRequest = await getPurchaseRequestWithItems(
        client,
        purchaseRequestId,
      )

      if (!purchaseRequest) {
        return res.status(404).json({ message: "Purchase request not found" })
      }

      if (
        purchaseRequest.status !== "ready_to_purchase" &&
        purchaseRequest.status !== "partially_purchased" &&
        purchaseRequest.status !== "partially_received"
      ) {
        return res.status(400).json({
          message: "This request is not ready to purchase",
        })
      }

      const remainingItems = (purchaseRequest.items ?? []).filter(
        (item: any) => Number(item.remaining_quantity ?? 0) > 0,
      )

      if (remainingItems.length === 0) {
        return res.status(400).json({
          message: "All requested quantities already have a purchase order",
        })
      }

      return res.json({
        ...purchaseRequest,
        items: remainingItems,
      })
    } catch (error) {
      console.error("Error fetching purchase request for buying:", error)

      return res.status(500).json({
        message: "Error fetching purchase request for buying",
      })
    } finally {
      client.release()
    }
  },
)


// router.get("/suppliers", actionPurchaseRequestLimiter, async (_req, res) => {
//   const client = await pool.connect()

//   try {
//     const suppliersResult = await client.query(
//       `
//       SELECT
//         id,
//         name,
//         address_snapshot,
//         phone,
//         email,
//         contact_name,
//         city,
//         province,
//         postal_code,
//         country,
//         is_active,
//         created_at,
//         updated_at
//       FROM portal.suppliers
//       WHERE is_active = true
//       ORDER BY lower(name) ASC
//       `,
//     )

//     return res.json(suppliersResult.rows)
//   } catch (error) {
//     console.error("Error fetching suppliers:", error)

//     return res.status(500).json({
//       message: "Error fetching suppliers",
//     })
//   } finally {
//     client.release()
//   }
// })


router.post(
  ["/:id/:token", "/:id/acheter/:token"],
  actionPurchaseRequestLimiter,
  async (req, res) => {
  const client = await pool.connect()
  let transactionStarted = false

  try {
    const { id } = req.params
    const purchaseRequestId = Number(id)

    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    const {
      purchase_mode,
      supplier_id,
      supplier_name,
      supplier_address_snapshot,
      supplier_phone,
      buyer_name,
      buyer_email,
      buyer_phone,
      requested_delivery_date,
      received_at,
      invoice_number,
      delivery_method,
      shipping_address_snapshot,
      supplier_reference,
      purchase_note,
      ordered_at,
      currency_code,
      items,
    } = req.body ?? {}

    const cleanSupplierId = cleanPositiveInteger(supplier_id)
   

    const orderItems = Array.isArray(items)
      ? (items as PurchaseOrderItemPayload[])
      : []

    if (orderItems.length === 0) {
      return res.status(400).json({
        message: "At least one purchase order item is required",
      })
    }

    const isPartialPurchase = purchase_mode === "partial"

if (purchase_mode !== "full" && purchase_mode !== "partial") {
  return res.status(400).json({
    message: "purchase_mode must be either 'full' or 'partial'",
  })
}

    await client.query("BEGIN")
    transactionStarted = true

    const purchaseToken = getPurchaseTokenFromRequest(req)

const isPurchaseTokenValid = await validatePurchaseToken(
  client,
  purchaseRequestId,
  purchaseToken,
)

if (!isPurchaseTokenValid || !purchaseToken) {
  await client.query("ROLLBACK")
  transactionStarted = false

  return res.status(403).json({
    message: "Invalid or expired purchase token",
  })
}

    const currentRequest = await client.query(
      `
      SELECT *
      FROM portal.purchase_requests
      WHERE id = $1
      FOR UPDATE
      `,
      [purchaseRequestId],
    )

    if (currentRequest.rows.length === 0) {
      await client.query("ROLLBACK")
      transactionStarted = false

      return res.status(404).json({ message: "Purchase request not found" })
    }

   const allowedPurchaseStatuses = [
     "ready_to_purchase",
     "partially_purchased",
     "partially_received",
   ]

if (!allowedPurchaseStatuses.includes(currentRequest.rows[0].status)) {
      await client.query("ROLLBACK")
      transactionStarted = false

      return res.status(400).json({
        message: "This request is not ready to purchase",
      })
    }

    const requestedItemIds = [
      ...new Set(
        orderItems
          .map((item) => cleanPositiveInteger(item.purchase_request_item_id))
          .filter((itemId): itemId is number => Boolean(itemId)),
      ),
    ]

    if (requestedItemIds.length > 0) {
      const requestedQuantitiesByItemId = orderItems.reduce((quantities, item) => {
        const itemId = cleanPositiveInteger(item.purchase_request_item_id)
        const quantity = cleanPositiveNumber(item.ordered_quantity)

        if (itemId && quantity) {
          quantities.set(itemId, (quantities.get(itemId) ?? 0) + quantity)
        }

        return quantities
      }, new Map<number, number>())
      const itemQuantitiesResult = await client.query(
        `
        SELECT
          pri.id,
          pri.quantity::numeric AS requested_quantity,
          COALESCE(SUM(poi.ordered_quantity), 0)::numeric AS already_ordered_quantity
        FROM portal.purchase_request_items pri
        LEFT JOIN portal.purchase_order_items poi
          ON poi.purchase_request_item_id = pri.id
        LEFT JOIN portal.purchase_orders po
          ON po.id = poi.purchase_order_id
          AND po.purchase_request_id = pri.purchase_request_id
        WHERE pri.purchase_request_id = $1
          AND pri.id = ANY($2::bigint[])
        GROUP BY pri.id, pri.quantity
        `,
        [purchaseRequestId, requestedItemIds],
      )

      const quantitiesByItemId = new Map(
        itemQuantitiesResult.rows.map((item) => [Number(item.id), item]),
      )
      const invalidItemId = requestedItemIds.find((itemId) => {
        const item = quantitiesByItemId.get(itemId)

        if (!item) return true

        return (
          Number(item.already_ordered_quantity) +
            (requestedQuantitiesByItemId.get(itemId) ?? 0) >
          Number(item.requested_quantity)
        )
      })

      if (invalidItemId) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(400).json({
          message: "The ordered quantity exceeds the remaining requested quantity",
        })
      }
    }



    let supplierSnapshot = {
      supplierId: cleanSupplierId,
      supplierName: cleanText(supplier_name),
      supplierAddressSnapshot: cleanText(supplier_address_snapshot),
      supplierPhone: cleanText(supplier_phone),
    }

    if (cleanSupplierId) {
      const supplierResult = await client.query(
        `
        SELECT id, name, address_snapshot, phone
        FROM portal.suppliers
        WHERE id = $1
          AND is_active = true
        `,
        [cleanSupplierId],
      )

      if (supplierResult.rows.length === 0) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(400).json({
          message: "Selected supplier was not found",
        })
      }

      const supplier = supplierResult.rows[0]

   supplierSnapshot = {
  supplierId: supplier.id,
  supplierName: supplier.name,
  supplierAddressSnapshot:
    cleanText(supplier_address_snapshot) ?? supplier.address_snapshot,
  supplierPhone:
    cleanText(supplier_phone) ?? supplier.phone,
}
    }

    if (!supplierSnapshot.supplierName) {
      await client.query("ROLLBACK")
      transactionStarted = false

      return res.status(400).json({
        message: "Supplier name is required",
      })
    }

const requestReference = cleanText(currentRequest.rows[0].request_reference)




if (!requestReference) {
  await client.query("ROLLBACK")
  transactionStarted = false

  return res.status(500).json({
    message: "Purchase request is missing request_reference",
  })
}

let requestSequence: number

try {
  requestSequence = getRequestSequenceFromReference(requestReference)
} catch (error) {
  await client.query("ROLLBACK")
  transactionStarted = false

  return res.status(500).json({
    message:
      error instanceof Error
        ? error.message
        : "Invalid purchase request reference sequence",
  })
}

if (!Number.isInteger(requestSequence) || requestSequence <= 0) {
  await client.query("ROLLBACK")
  transactionStarted = false

  return res.status(500).json({
    message: "Invalid purchase request reference sequence",
  })
}

await client.query(
  `
  SELECT pg_advisory_xact_lock(hashtext($1))
  `,
  [`portal.purchase_orders.request.${purchaseRequestId}`],
)

const existingOrdersForRequest = await client.query(
  `
  SELECT
    COALESCE(MAX(purchase_order_subsequence), 0) AS max_subsequence,
    COUNT(*) AS order_count
  FROM portal.purchase_orders
  WHERE purchase_request_id = $1
  `,
  [purchaseRequestId],
)

const requestAlreadyHasPurchaseOrders =
  Number(existingOrdersForRequest.rows[0].order_count) > 0

const shouldUseSubsequence =
  isPartialPurchase || requestAlreadyHasPurchaseOrders

let purchaseOrderSubsequence: number | null = null

if (shouldUseSubsequence) {
  purchaseOrderSubsequence =
    Number(existingOrdersForRequest.rows[0].max_subsequence) + 1
}

const purchaseOrderReference = formatPurchaseOrderReference(
  requestReference,
  purchaseOrderSubsequence,
)

    const purchaseOrderResult = await client.query(
      `
      INSERT INTO portal.purchase_orders (
        purchase_request_id,
        purchase_order_reference,
        purchase_order_sequence,
        purchase_order_subsequence,
        supplier_id,
        supplier,
        supplier_name,
        supplier_address_snapshot,
        supplier_phone,
        purchased_at,
        supplier_reference,
        purchase_note,
        buyer_name,
        buyer_email,
        buyer_phone,
        requested_delivery_date,
        received_at,
        invoice_number,
        delivery_method,
        shipping_address_snapshot,
        currency_code,
        status
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, COALESCE($10::timestamptz, now()),
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21,
        'ordered'
      )
      RETURNING *
      `,
     [
  purchaseRequestId,
  purchaseOrderReference,
  requestSequence,
  purchaseOrderSubsequence,
  supplierSnapshot.supplierId,
  supplierSnapshot.supplierName,
  supplierSnapshot.supplierName,
  supplierSnapshot.supplierAddressSnapshot,
  supplierSnapshot.supplierPhone,
  cleanDate(ordered_at),
  cleanText(supplier_reference),
  cleanText(purchase_note),
  cleanText(buyer_name),
  cleanText(buyer_email),
  cleanText(buyer_phone),
  cleanDate(requested_delivery_date),
  cleanDate(received_at),
  cleanText(invoice_number),
  cleanText(delivery_method),
  cleanText(shipping_address_snapshot),
  cleanText(currency_code) ?? "CAD",
]
    )

    let purchaseOrder = purchaseOrderResult.rows[0]

    const insertedItems: any[] = []

    for (const item of orderItems) {
      const cleanPurchaseRequestItemId = cleanPositiveInteger(
        item.purchase_request_item_id,
      )
      const cleanOrderedQuantity = cleanPositiveNumber(item.ordered_quantity)
      const cleanFinalUnitPrice = cleanPositiveNumber(item.final_unit_price)

      if (!cleanPurchaseRequestItemId) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(400).json({
          message: "Each item requires a purchase_request_item_id",
        })
      }

      const requestItemResult = await client.query(
  `
  SELECT id
  FROM portal.purchase_request_items
  WHERE id = $1
    AND purchase_request_id = $2
  `,
  [cleanPurchaseRequestItemId, purchaseRequestId],
)

if (requestItemResult.rows.length === 0) {
  await client.query("ROLLBACK")
  transactionStarted = false

  return res.status(400).json({
    message: "One of the items does not belong to this purchase request",
  })
}

      if (!cleanOrderedQuantity) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(400).json({
          message: "Each item requires a valid ordered_quantity",
        })
      }

    

   const itemResult = await client.query(
  `
  INSERT INTO portal.purchase_order_items (
    purchase_order_id,
    purchase_request_item_id,
    ordered_quantity,
    final_unit_price,
    item_code,
    number_of_pallets,
    item_description,
    ordered_unit,
    location
  )
  VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8, $9
  )
  RETURNING *
  `,
  [
    purchaseOrder.id,
    cleanPurchaseRequestItemId,
    cleanOrderedQuantity,
    cleanFinalUnitPrice,
    cleanText(item.item_code),
    cleanNumber(item.number_of_pallets),
    cleanText(item.item_description),
    cleanText(item.ordered_unit),
    cleanText(item.location),
  ],
)

      insertedItems.push(itemResult.rows[0])
    }

const purchaseOrderDocuments = await Promise.all(
  (["fr", "en"] as const).map(async (language) => {
    const key = createPurchaseOrderPdfKey(purchaseOrder.id, purchaseOrder.purchase_order_reference, language)
    const filename = createPurchaseOrderPdfFilename(purchaseOrder.purchase_order_reference, language)
    const bytes = await generatePurchaseOrderPdf({ ...purchaseOrder, items: insertedItems }, language)
    await uploadBufferToS3({ key, buffer: Buffer.from(bytes), contentType: "application/pdf" })
    return { language, key, filename }
  }),
)

const purchaseOrderWithDocumentResult = await client.query(
  `
  UPDATE portal.purchase_orders
  SET purchase_document_keys = $1
  WHERE id = $2
  RETURNING *
  `,
  [purchaseOrderDocuments.map((document) => document.key), purchaseOrder.id],
)

purchaseOrder = purchaseOrderWithDocumentResult.rows[0]

const purchaseOrderPdfLinks = await Promise.all(purchaseOrderDocuments.map(async (document) => ({
  language: document.language,
  key: document.key,
  preview_url: await getSignedUrlForKey(document.key, {
    expiresIn: 60 * 60,
    responseContentDisposition: createPdfPreviewDisposition(
      document.filename,
    ),
    responseContentType: "application/pdf",
  }),
  download_url: await getSignedUrlForKey(document.key, {
    expiresIn: 60 * 60,
    responseContentDisposition: createPdfDownloadDisposition(
      document.filename,
    ),
    responseContentType: "application/pdf",
  }),
})))

const remainingRequestedQuantityResult = await client.query(
  `
  SELECT EXISTS (
    SELECT 1
    FROM portal.purchase_request_items pri
    LEFT JOIN (
      SELECT
        poi.purchase_request_item_id,
        SUM(poi.ordered_quantity)::numeric AS ordered_quantity
      FROM portal.purchase_order_items poi
      INNER JOIN portal.purchase_orders po
        ON po.id = poi.purchase_order_id
      WHERE po.purchase_request_id = $1
      GROUP BY poi.purchase_request_item_id
    ) ordered
      ON ordered.purchase_request_item_id = pri.id
    WHERE pri.purchase_request_id = $1
      AND COALESCE(ordered.ordered_quantity, 0) < pri.quantity
  ) AS has_remaining_quantity
  `,
  [purchaseRequestId],
)
const nextRequestStatus = remainingRequestedQuantityResult.rows[0].has_remaining_quantity
  ? "partially_purchased"
  : "purchased"

const updatedRequest = await client.query(
  `
  UPDATE portal.purchase_requests
  SET status = $2
  WHERE id = $1
  RETURNING *
  `,
  [purchaseRequestId, nextRequestStatus],
)

const receiptVoucherToken = await getOrCreateActiveReceiptVoucherToken(
  client,
  purchaseRequestId,
)
const receiptVoucherUrl = buildReceiptVoucherUrl(
  req,
  purchaseRequestId,
  receiptVoucherToken,
)

if (nextRequestStatus === "purchased") {
  await markPurchaseTokenUsed(client, purchaseRequestId, purchaseToken)
}

await client.query("COMMIT")
transactionStarted = false

    return res.status(201).json({
      purchase_request: updatedRequest.rows[0],
      purchase_order: purchaseOrder,
      purchase_order_items: insertedItems,
      purchase_order_pdf_urls: purchaseOrderPdfLinks.map((link) => link.preview_url),
      purchase_order_pdf_preview_urls: purchaseOrderPdfLinks.map((link) => link.preview_url),
      purchase_order_pdf_download_urls: purchaseOrderPdfLinks.map((link) => link.download_url),
      purchase_order_pdfs: purchaseOrderPdfLinks,
      purchase_order_pdf: purchaseOrderPdfLinks[0],
      receipt_voucher_token: receiptVoucherToken,
      receipt_voucher_url: receiptVoucherUrl,
    })
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK")
    }

   if ((error as { code?: string; constraint?: string; detail?: string }).code === "23505") {
  console.error("Purchase order unique constraint error:", {
    constraint: (error as { constraint?: string }).constraint,
    detail: (error as { detail?: string }).detail,
  })

  return res.status(409).json({
    message: "A purchase order with this reference already exists",
    constraint: (error as { constraint?: string }).constraint,
    detail: (error as { detail?: string }).detail,
  })
}

    console.error("Error creating purchase order:", error)

    return res.status(500).json({
      message: "Error creating purchase order",
    })
  } finally {
    client.release()
  }
})



export default router
