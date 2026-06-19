import express from "express"
import { pool } from "../../db"
import rateLimit from "express-rate-limit"

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

export const actionPurchaseRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Trop d'actions envoyées. Réessayez plus tard.",
  },
})

router.post("/:id", actionPurchaseRequestLimiter, async (req, res) => {
  const client = await pool.connect()
  let transactionStarted = false

  try {
    const { id } = req.params
    const purchaseRequestId = Number(id)

    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    const {
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
      purchase_reference,
      purchase_note,
      purchased_by_user_id,
      ordered_at,
      currency_code,
      items,
    } = req.body ?? {}

    const cleanSupplierId = cleanPositiveInteger(supplier_id)
    const cleanPurchasedByUserId = cleanPositiveInteger(purchased_by_user_id)

    if (!cleanPurchasedByUserId) {
      return res.status(400).json({
        message: "Missing purchased_by_user_id",
      })
    }

    const orderItems = Array.isArray(items)
      ? (items as PurchaseOrderItemPayload[])
      : []

    if (orderItems.length === 0) {
      return res.status(400).json({
        message: "At least one purchase order item is required",
      })
    }

    await client.query("BEGIN")
    transactionStarted = true

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

    if (currentRequest.rows[0].status !== "ready_to_purchase") {
      await client.query("ROLLBACK")
      transactionStarted = false

      return res.status(400).json({
        message: "This request is not ready to purchase",
      })
    }

    const existingOrder = await client.query(
      `
      SELECT id
      FROM portal.purchase_orders
      WHERE purchase_request_id = $1
      `,
      [purchaseRequestId],
    )

    if (existingOrder.rows.length > 0) {
      await client.query("ROLLBACK")
      transactionStarted = false

      return res.status(409).json({
        message: "This purchase request already has a purchase order",
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

    const sequenceResult = await client.query(
      `
      SELECT COALESCE(MAX(purchase_order_sequence), 0) + 1 AS next_sequence
      FROM portal.purchase_orders
      WHERE purchase_order_reference LIKE $1
      `,
      [`${orderMonthKey}-%`],
    )

    const nextSequence = Number(sequenceResult.rows[0].next_sequence)
    const purchaseOrderReference = `${orderMonthKey}-${String(nextSequence).padStart(3, "0")}`

    const purchaseOrderResult = await client.query(
      `
      INSERT INTO portal.purchase_orders (
        purchase_request_id,
        purchase_order_reference,
        purchase_order_sequence,
        supplier_id,
        supplier,
        supplier_name,
        supplier_address_snapshot,
        supplier_phone,
        purchased_by_user_id,
        purchased_at,
        purchase_reference,
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
        nextSequence,
        supplierSnapshot.supplierId,
        supplierSnapshot.supplierName,
        supplierSnapshot.supplierName,
        supplierSnapshot.supplierAddressSnapshot,
        supplierSnapshot.supplierPhone,
        cleanPurchasedByUserId,
        cleanDate(ordered_at),
        cleanText(purchase_reference),
        cleanText(purchase_note),
        cleanText(buyer_name),
        cleanText(buyer_email),
        cleanDate(requested_delivery_date),
        cleanDate(received_at),
        cleanText(invoice_number),
        cleanText(delivery_method),
        cleanText(shipping_address_snapshot),
        cleanText(currency_code) ?? "CAD",
      ],
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

      if (!cleanOrderedQuantity) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(400).json({
          message: "Each item requires a valid ordered_quantity",
        })
      }

      const finalTotalPrice =
        cleanFinalUnitPrice !== null
          ? cleanOrderedQuantity * cleanFinalUnitPrice
          : null

      const itemResult = await client.query(
        `
        INSERT INTO portal.purchase_order_items (
          purchase_order_id,
          purchase_request_item_id,
          ordered_quantity,
          final_unit_price,
          final_total_price,
          item_code,
          number_of_pallets,
          item_description,
          ordered_unit,
          location
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10
        )
        RETURNING *
        `,
        [
          purchaseOrder.id,
          cleanPurchaseRequestItemId,
          cleanOrderedQuantity,
          cleanFinalUnitPrice,
          finalTotalPrice,
          cleanText(item.item_code),
          cleanNumber(item.number_of_pallets),
          cleanText(item.item_description),
          cleanText(item.ordered_unit),
          cleanText(item.location),
        ],
      )

      insertedItems.push(itemResult.rows[0])
    }

    const updatedRequest = await client.query(
      `
      UPDATE portal.purchase_requests
      SET status = 'purchased'
      WHERE id = $1
      RETURNING *
      `,
      [purchaseRequestId],
    )

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
        message: "This purchase request already has a purchase order",
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