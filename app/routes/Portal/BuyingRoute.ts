import express from "express"
import { pool } from "../../db"

import { actionPurchaseRequestLimiter } from "../Portal/Utils/purchaseRequestLimiters"
import { getPurchaseTokenFromRequest, validatePurchaseToken, markPurchaseTokenUsed } from "./Utils/PurchaseHelper"
import { getPurchaseRequestWithItems } from "./PurchaseRequest"

const router = express.Router()

const cleanText = (value: unknown) => {
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

      if (purchaseRequest.status !== "ready_to_purchase") {
        return res.status(400).json({
          message: "This request is not ready to purchase",
        })
      }

      return res.json(purchaseRequest)
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


router.get("/suppliers", actionPurchaseRequestLimiter, async (_req, res) => {
  const client = await pool.connect()

  try {
    const suppliersResult = await client.query(
      `
      SELECT
        id,
        name,
        address_snapshot,
        phone,
        email,
        contact_name,
        city,
        province,
        postal_code,
        country,
        is_active,
        created_at,
        updated_at
      FROM portal.suppliers
      WHERE is_active = true
      ORDER BY lower(name) ASC
      `,
    )

    return res.json(suppliersResult.rows)
  } catch (error) {
    console.error("Error fetching suppliers:", error)

    return res.status(500).json({
      message: "Error fetching suppliers",
    })
  } finally {
    client.release()
  }
})


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

   const allowedPurchaseStatuses = ["ready_to_purchase", "partially_purchased"]

if (!allowedPurchaseStatuses.includes(currentRequest.rows[0].status)) {
      await client.query("ROLLBACK")
      transactionStarted = false

      return res.status(400).json({
        message: "This request is not ready to purchase",
      })
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
        supplierAddressSnapshot: supplier.address_snapshot,
        supplierPhone: supplier.phone,
      }
    }

    if (!supplierSnapshot.supplierName) {
      await client.query("ROLLBACK")
      transactionStarted = false

      return res.status(400).json({
        message: "Supplier name is required",
      })
    }

    const orderMonthKey = getOrderMonthKey(ordered_at)

    await client.query(
      `
      SELECT pg_advisory_xact_lock(hashtext($1))
      `,
      [`portal.purchase_orders.${orderMonthKey}`],
    )

const existingOrdersForRequest = await client.query(
  `
  SELECT
    purchase_order_sequence,
    COALESCE(MAX(purchase_order_subsequence), 0) AS max_subsequence,
    COUNT(*) AS order_count
  FROM portal.purchase_orders
  WHERE purchase_request_id = $1
  GROUP BY purchase_order_sequence
  ORDER BY purchase_order_sequence
  LIMIT 1
  `,
  [purchaseRequestId],
)

const requestAlreadyHasPurchaseOrders =
  existingOrdersForRequest.rows.length > 0

const shouldUseSubsequence =
  isPartialPurchase || requestAlreadyHasPurchaseOrders

let purchaseOrderSequence: number

if (requestAlreadyHasPurchaseOrders) {
  purchaseOrderSequence = Number(
    existingOrdersForRequest.rows[0].purchase_order_sequence,
  )
} else {
  const sequenceResult = await client.query(
    `
    SELECT COALESCE(MAX(purchase_order_sequence), 0) + 1 AS next_sequence
    FROM portal.purchase_orders
    WHERE purchase_order_reference LIKE $1
    `,
    [`${orderMonthKey}-%`],
  )

  purchaseOrderSequence = Number(sequenceResult.rows[0].next_sequence)
}

let purchaseOrderSubsequence: number | null = null

if (shouldUseSubsequence) {
  purchaseOrderSubsequence = requestAlreadyHasPurchaseOrders
    ? Number(existingOrdersForRequest.rows[0].max_subsequence) + 1
    : 1
}

const baseReference = `${orderMonthKey}-${String(purchaseOrderSequence).padStart(3, "0")}`

const purchaseOrderReference =
  purchaseOrderSubsequence === null
    ? baseReference
    : `${baseReference}-${String(purchaseOrderSubsequence).padStart(2, "0")}`

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
        'ordered'
      )
      RETURNING *
      `,
     [
  purchaseRequestId,
  purchaseOrderReference,
  purchaseOrderSequence,
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
  cleanDate(requested_delivery_date),
  cleanDate(received_at),
  cleanText(invoice_number),
  cleanText(delivery_method),
  cleanText(shipping_address_snapshot),
  cleanText(currency_code) ?? "CAD",
]
    )

    const purchaseOrder = purchaseOrderResult.rows[0]

    const insertedItems = []

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

const nextRequestStatus = isPartialPurchase
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

if (nextRequestStatus === "purchased") {
  await markPurchaseTokenUsed(client, purchaseRequestId, purchaseToken)
}

await client.query("COMMIT")
transactionStarted = false

   

    await client.query("COMMIT")
    transactionStarted = false

    

    return res.status(201).json({
      purchase_request: updatedRequest.rows[0],
      purchase_order: purchaseOrder,
      purchase_order_items: insertedItems,
    })
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK")
    }

    if ((error as { code?: string }).code === "23505") {
      return res.status(409).json({
        message: "A purchase order with this reference already exists",
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