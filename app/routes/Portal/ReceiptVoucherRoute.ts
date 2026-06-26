// routes/Portal/ReceiptVoucherRoute.ts
import express from "express"
import { pool } from "../../db"
import {
  getReceiptVoucherTokenFromRequest,
  validateReceiptVoucherToken,
} from "./Utils/PurchaseHelper"

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

const formatReceiptVoucherReference = (
  requestReference: string,
  sequence: number,
) => {
  if (sequence === 1) return requestReference

  return `${requestReference}-R${String(sequence).padStart(2, "0")}`
}

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

    const receiptVoucher = voucherResult.rows[0]

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

    await client.query("COMMIT")

    return res.status(201).json({
      purchase_request: updatedRequestResult.rows[0],
      receipt_voucher: receiptVoucher,
      items: insertedItems,
      ordered_total_quantity: orderedTotalQuantity,
      received_total_quantity: receivedTotalQuantity,
      has_receivable_items: receivedTotalQuantity < orderedTotalQuantity,
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
