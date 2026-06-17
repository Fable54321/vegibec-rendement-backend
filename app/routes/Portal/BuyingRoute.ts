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

const cleanDate = (value: unknown) => {
  if (typeof value !== "string") return null

  const trimmed = value.trim()

  if (!trimmed) return null

  return trimmed
}


export const actionPurchaseRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Trop d'actions envoyées. Réessayez plus tard.",
  },
})

router.post(
  "/:id",
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

      const existingConfirmation = await client.query(
        `
        SELECT id
        FROM portal.purchase_confirmation
        WHERE request_id = $1
        `,
        [purchaseRequestId],
      )

      if (existingConfirmation.rows.length > 0) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(409).json({
          message: "This purchase request has already been confirmed",
        })
      }

      const {
        final_supplier,
        supplier_address,
        picked_up_from,
        delivered_to,
        ordered_at,
        picked_up_at,
        received_at,
        expected_by,
        receipt_number,
        delivered_by,
        reference_number_1,
        reference_number_2,
        buyer,
        buyer_email,
        temperature,
        code,
        description,
        final_quantity,
        number_of_pallets,
        final_unit_price,
      } = req.body ?? {}

      const cleanFinalQuantity = cleanNumber(final_quantity)
      const cleanFinalUnitPrice = cleanNumber(final_unit_price)

      const finalTotalPrice =
        cleanFinalQuantity !== null && cleanFinalUnitPrice !== null
          ? cleanFinalQuantity * cleanFinalUnitPrice
          : null

      const confirmationResult = await client.query(
        `
        INSERT INTO portal.purchase_confirmation (
          request_id,
          final_supplier,
          supplier_address,
          picked_up_from,
          delivered_to,
          ordered_at,
          picked_up_at,
          received_at,
          expected_by,
          receipt_number,
          delivered_by,
          reference_number_1,
          reference_number_2,
          buyer,
          buyer_email,
          temperature,
          code,
          description,
          final_quantity,
          number_of_pallets,
          final_unit_price,
          final_total_price
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20,
          $21, $22
        )
        RETURNING *
        `,
        [
          purchaseRequestId,
          cleanText(final_supplier),
          cleanText(supplier_address),
          cleanText(picked_up_from),
          cleanText(delivered_to),
          cleanDate(ordered_at),
          cleanDate(picked_up_at),
          cleanDate(received_at),
          cleanDate(expected_by),
          cleanText(receipt_number),
          cleanText(delivered_by),
          cleanText(reference_number_1),
          cleanText(reference_number_2),
          cleanText(buyer),
          cleanText(buyer_email),
          cleanNumber(temperature),
          cleanText(code),
          cleanText(description),
          cleanFinalQuantity,
          cleanNumber(number_of_pallets),
          cleanFinalUnitPrice,
          finalTotalPrice,
        ],
      )

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
        purchase_confirmation: confirmationResult.rows[0],
      })
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK")
      }

      if ((error as { code?: string }).code === "23505") {
        return res.status(409).json({
          message: "This purchase request has already been confirmed",
        })
      }

      console.error("Error confirming purchase:", error)

      return res.status(500).json({
        message: "Error confirming purchase",
      })
    } finally {
      client.release()
    }
  },
)

export default router