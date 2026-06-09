import express from "express"
import { pool } from "../../db"

const router = express.Router()

const VALID_STATUSES = [
  "pending_buyer_validation",
  "needs_requester_info",
  "pending_admin_approval",
  "approved",
  "rejected",
  "ready_to_purchase",
  "purchased",
  "cancelled",
]

const getUrgencyFromExpectedDate = (expectedDate: string | null) => {
  if (!expectedDate) return "normal"

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const selectedDate = new Date(`${expectedDate}T00:00:00`)
  selectedDate.setHours(0, 0, 0, 0)

  const differenceInMs = selectedDate.getTime() - today.getTime()
  const differenceInDays = Math.ceil(differenceInMs / (1000 * 60 * 60 * 24))

  if (differenceInDays <= 1) return "Au plus vite"
  if (differenceInDays <= 7) return "Urgent"
  if (differenceInDays <= 14) return "Urgence medium"

  return "normal"
}

// GET /api/purchase-requests
router.get("/", async (req, res) => {
  try {
    const { status } = req.query

    let query = `
      SELECT 
        pr.*,
        buyer.name AS buyer_name,
        buyer.surname AS buyer_surname,
        admin.name AS admin_name,
        admin.surname AS admin_surname
      FROM portal.purchase_requests pr
      LEFT JOIN public.users buyer ON buyer.id = pr.buyer_user_id
      LEFT JOIN public.users admin ON admin.id = pr.admin_user_id
    `

    const params: unknown[] = []

    if (status) {
      if (!VALID_STATUSES.includes(String(status))) {
        return res.status(400).json({ message: "Invalid status" })
      }

      params.push(status)
      query += ` WHERE pr.status = $1`
    }

    query += ` ORDER BY pr.created_at DESC`

    const result = await pool.query(query, params)

    res.json(result.rows)
  } catch (error) {
    console.error("Error fetching purchase requests:", error)
    res.status(500).json({ message: "Error fetching purchase requests" })
  }
})

// GET /api/purchase-requests/:id
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query(
      `
      SELECT 
        pr.*,
        requester.surname AS requester_surname,
        buyer.name AS buyer_name,
        buyer.surname AS buyer_surname,
        admin.name AS admin_name,
        admin.surname AS admin_surname,
        purchased_by.name AS purchased_by_name,
        purchased_by.surname AS purchased_by_surname
      FROM portal.purchase_requests pr
      LEFT JOIN public.users buyer ON buyer.id = pr.buyer_user_id
      LEFT JOIN public.users admin ON admin.id = pr.admin_user_id
      LEFT JOIN public.users purchased_by ON purchased_by.id = pr.purchased_by_user_id
      WHERE pr.id = $1
      `,
      [id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    res.json(result.rows[0])
  } catch (error) {
    console.error("Error fetching purchase request:", error)
    res.status(500).json({ message: "Error fetching purchase request" })
  }
})


router.post("/", async (req, res) => {
  try {
    const {
      requested_by,
      description,
      quantity,
      reason,
      requested_unit_price,
      requested_supplier,
      product_link,
      expected_date,
    } = req.body

    if (!requested_by || !quantity) {
      return res.status(400).json({
        message: "La description du produit et la quantité sont requises",
      })
    }

    const cleanQuantity = Number(quantity || 1)
    const cleanUnitPrice =
      requested_unit_price === "" || requested_unit_price === undefined
        ? null
        : Number(requested_unit_price)

    const requestedTotalPrice =
      cleanUnitPrice !== null ? cleanUnitPrice * cleanQuantity : null

    const urgency = getUrgencyFromExpectedDate(expected_date || null)

    const result = await pool.query(
      `
      INSERT INTO portal.purchase_requests (
        requested_by,
        description,
        quantity,
        reason,
        urgency,
        requested_unit_price,
        requested_total_price,
        requested_supplier,
        product_link,
        expected_date,
        status
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        'pending_buyer_validation'
      )
      RETURNING *
      `,
      [
        requested_by,
        description || null,
        cleanQuantity,
        reason || null,
        urgency,
        cleanUnitPrice,
        requestedTotalPrice,
        requested_supplier || null,
        product_link || null,
        expected_date || null,
      ]
    )

    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error("Error creating purchase request:", error)
    res.status(500).json({ message: "Error creating purchase request" })
  }
})

// PATCH /api/purchase-requests/:id/buyer-validation
router.patch("/:id/buyer-validation", async (req, res) => {
  try {
    const { id } = req.params

    const {
      buyer_user_id,
      buyer_confirmed_unit_price,
      buyer_confirmed_supplier,
      buyer_note,
      needs_requester_info,
      reject,
      rejection_reason,
    } = req.body

    if (!buyer_user_id) {
      return res.status(400).json({ message: "buyer_user_id is required" })
    }

    const currentRequest = await pool.query(
      `
      SELECT *
      FROM portal.purchase_requests
      WHERE id = $1
      `,
      [id]
    )

    if (currentRequest.rows.length === 0) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    if (currentRequest.rows[0].status !== "pending_buyer_validation") {
      return res.status(400).json({
        message: "This request is not pending buyer validation",
      })
    }

    let newStatus = "pending_admin_approval"

    if (needs_requester_info) {
      newStatus = "needs_requester_info"
    }

    if (reject) {
      newStatus = "rejected"
    }

    const quantity = Number(currentRequest.rows[0].quantity || 1)

    const cleanConfirmedUnitPrice =
      buyer_confirmed_unit_price === "" ||
      buyer_confirmed_unit_price === undefined
        ? null
        : Number(buyer_confirmed_unit_price)

    const buyerConfirmedTotalPrice =
      cleanConfirmedUnitPrice !== null ? cleanConfirmedUnitPrice * quantity : null

    const result = await pool.query(
      `
      UPDATE portal.purchase_requests
      SET
        buyer_user_id = $1,
        buyer_confirmed_unit_price = $2,
        buyer_confirmed_total_price = $3,
        buyer_confirmed_supplier = $4,
        buyer_note = $5,
        buyer_validated_at = now(),
        status = $6,
        rejection_reason = $7
      WHERE id = $8
      RETURNING *
      `,
      [
        buyer_user_id,
        cleanConfirmedUnitPrice,
        buyerConfirmedTotalPrice,
        buyer_confirmed_supplier || null,
        buyer_note || null,
        newStatus,
        rejection_reason || null,
        id,
      ]
    )

    res.json(result.rows[0])
  } catch (error) {
    console.error("Error validating purchase request:", error)
    res.status(500).json({ message: "Error validating purchase request" })
  }
})

// PATCH /api/purchase-requests/:id/admin-decision
router.patch("/:id/admin-decision", async (req, res) => {
  try {
    const { id } = req.params
    const { admin_user_id, approved, admin_note, rejection_reason } = req.body

    if (!admin_user_id) {
      return res.status(400).json({ message: "admin_user_id is required" })
    }

    if (typeof approved !== "boolean") {
      return res.status(400).json({ message: "approved must be true or false" })
    }

    const currentRequest = await pool.query(
      `
      SELECT *
      FROM portal.purchase_requests
      WHERE id = $1
      `,
      [id]
    )

    if (currentRequest.rows.length === 0) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    if (currentRequest.rows[0].status !== "pending_admin_approval") {
      return res.status(400).json({
        message: "This request is not pending admin approval",
      })
    }

    const newStatus = approved ? "ready_to_purchase" : "rejected"

    const result = await pool.query(
      `
      UPDATE portal.purchase_requests
      SET
        admin_user_id = $1,
        admin_decision_at = now(),
        admin_note = $2,
        status = $3,
        rejection_reason = $4
      WHERE id = $5
      RETURNING *
      `,
      [
        admin_user_id,
        admin_note || null,
        newStatus,
        approved ? null : rejection_reason || null,
        id,
      ]
    )

    res.json(result.rows[0])
  } catch (error) {
    console.error("Error saving admin decision:", error)
    res.status(500).json({ message: "Error saving admin decision" })
  }
})

// PATCH /api/purchase-requests/:id/mark-purchased
router.patch("/:id/mark-purchased", async (req, res) => {
  try {
    const { id } = req.params

    const {
      purchased_by_user_id,
      final_unit_price,
      purchase_reference,
      purchase_note,
    } = req.body

    if (!purchased_by_user_id) {
      return res.status(400).json({ message: "purchased_by_user_id is required" })
    }

    const currentRequest = await pool.query(
      `
      SELECT *
      FROM portal.purchase_requests
      WHERE id = $1
      `,
      [id]
    )

    if (currentRequest.rows.length === 0) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    if (currentRequest.rows[0].status !== "ready_to_purchase") {
      return res.status(400).json({
        message: "This request is not ready to purchase",
      })
    }

    const quantity = Number(currentRequest.rows[0].quantity || 1)

    const cleanFinalUnitPrice =
      final_unit_price === "" || final_unit_price === undefined
        ? null
        : Number(final_unit_price)

    const finalTotalPrice =
      cleanFinalUnitPrice !== null ? cleanFinalUnitPrice * quantity : null

    const result = await pool.query(
      `
      UPDATE portal.purchase_requests
      SET
        purchased_by_user_id = $1,
        final_unit_price = $2,
        final_total_price = $3,
        purchased_at = now(),
        purchase_reference = $4,
        purchase_note = $5,
        status = 'purchased'
      WHERE id = $6
      RETURNING *
      `,
      [
        purchased_by_user_id,
        cleanFinalUnitPrice,
        finalTotalPrice,
        purchase_reference || null,
        purchase_note || null,
        id,
      ]
    )

    res.json(result.rows[0])
  } catch (error) {
    console.error("Error marking purchase request as purchased:", error)
    res.status(500).json({ message: "Error marking purchase request as purchased" })
  }
})

// PATCH /api/purchase-requests/:id/cancel
router.patch("/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params
    const { rejection_reason } = req.body

    const result = await pool.query(
      `
      UPDATE portal.purchase_requests
      SET
        status = 'cancelled',
        rejection_reason = $1
      WHERE id = $2
      RETURNING *
      `,
      [rejection_reason || null, id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    res.json(result.rows[0])
  } catch (error) {
    console.error("Error cancelling purchase request:", error)
    res.status(500).json({ message: "Error cancelling purchase request" })
  }
})

export default router