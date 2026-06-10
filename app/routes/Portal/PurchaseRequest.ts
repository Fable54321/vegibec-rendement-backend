import express from "express"
import { pool } from "../../db"
import crypto from "crypto"
import rateLimit from "express-rate-limit"
import {
  buildAdminApprovalEmail,
  buildAdminApprovalEmailHtml,
  buildBuyerDecisionEmail,
  buildAdminApprovalUrl,
  buildBuyerValidationUrl,
  buildNewPurchaseRequestEmail,
  buildNewPurchaseRequestEmailHtml,
  buildPictureEmailLinks,
  createAdminApprovalToken,
  createBuyerValidationToken,
  createPurchaseRequestPictureKey,
  getAdminApprovalTokenFromRequest,
  getBuyerValidationTokenFromRequest,
  getEmailRecipients,
  getUrgencyFromExpectedDate,
  markAdminApprovalTokenUsed,
  markBuyerValidationTokenUsed,
  sendPurchaseRequestEmailSafely,
  uploadPurchaseRequestPictures,
  validateAdminApprovalToken,
  validateBuyerValidationToken,
} from "../../routes/Portal/Utils/PurchaseHelper"
import { uploadBufferToS3 } from "../../services/s3.services"

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

const formTokenLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Trop de tentatives de préparation du formulaire. Réessayez plus tard.",
  },
})

const createPurchaseRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Trop de demandes envoyées. Réessayez plus tard.",
  },
})

const readPurchaseRequestsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Trop de requêtes. Réessayez plus tard.",
  },
})

const actionPurchaseRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Trop d'actions envoyées. Réessayez plus tard.",
  },
})

router.get("/form-token", formTokenLimiter, async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString("hex")

    const result = await pool.query(
      `
      INSERT INTO portal.purchase_request_form_tokens (
        token,
        expires_at
      )
      VALUES (
        $1,
        now() + interval '30 minutes'
      )
      RETURNING token, expires_at
      `,
      [token]
    )

    res.json(result.rows[0])
  } catch (error) {
    console.error("Error creating purchase request form token:", error)
    res.status(500).json({
      message: "Error creating form token",
    })
  }
})

// GET /api/purchase-requests
router.get("/", readPurchaseRequestsLimiter, async (req, res) => {
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
router.get("/:id", readPurchaseRequestsLimiter, async (req, res) => {
  try {
    const { id } = req.params

    if (!/^\d+$/.test(id)) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    const result = await pool.query(
      `
      SELECT 
        pr.*,
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
      [Number(id)]
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


const requireValidFormToken = async (req : any, res : any, next : any) => {
  try {
    const token = req.headers["x-purchase-request-form-token"]

    if (!token || typeof token !== "string") {
      return res.status(403).json({
        message: "Jeton de formulaire manquant",
      })
    }

    const result = await pool.query(
      `
      SELECT *
      FROM portal.purchase_request_form_tokens
      WHERE token = $1
        AND used_at IS NULL
        AND expires_at > now()
      `,
      [token]
    )

    if (result.rows.length === 0) {
      return res.status(403).json({
        message: "Jeton de formulaire invalide ou expiré",
      })
    }

    req.purchaseRequestFormToken = token

    next()
  } catch (error) {
    console.error("Error validating form token:", error)
    res.status(500).json({
      message: "Error validating form token",
    })
  }
}

router.post(
  "/",
  createPurchaseRequestLimiter,
  uploadPurchaseRequestPictures.array("pictures", 5),
  requireValidFormToken,
  async (req, res) => {
  const client = await pool.connect()

  try {
  const body = req.body ?? {}
const pictures = (req.files as Express.Multer.File[]) ?? []

const {
  requested_by,
  description,
  quantity,
  reason,
  requested_unit_price,
  requested_supplier,
  product_link,
  expected_date,
  companyWebsite,
} = body

   
    if (companyWebsite) {
      return res.status(400).json({ message: "Invalid request" })
    }

    if (!requested_by || !description) {
      return res.status(400).json({
        message: "Le demandeur et la description du produit sont requis",
      })
    }

    const cleanQuantity = Number(quantity || 1)

    if (!Number.isFinite(cleanQuantity) || cleanQuantity <= 0) {
      return res.status(400).json({
        message: "La quantité doit être un nombre supérieur à 0",
      })
    }

    const cleanUnitPrice =
      requested_unit_price === "" ||
      requested_unit_price === undefined ||
      requested_unit_price === null
        ? null
        : Number(requested_unit_price)

    if (
      cleanUnitPrice !== null &&
      (!Number.isFinite(cleanUnitPrice) || cleanUnitPrice < 0)
    ) {
      return res.status(400).json({
        message: "Le prix doit être un nombre valide",
      })
    }

    const requestedTotalPrice =
      cleanUnitPrice !== null ? cleanUnitPrice * cleanQuantity : null

    const urgency = getUrgencyFromExpectedDate(expected_date || null)
    const formToken = (req as any).purchaseRequestFormToken

    await client.query("BEGIN")

    const tokenResult = await client.query(
      `
      UPDATE portal.purchase_request_form_tokens
      SET used_at = now()
      WHERE token = $1
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING id
      `,
      [formToken]
    )

    if (tokenResult.rows.length === 0) {
      await client.query("ROLLBACK")

      return res.status(403).json({
        message: "Jeton de formulaire invalide ou expiré",
      })
    }

const result = await client.query(
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
    requested_by.trim(),
    description.trim(),
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

let createdRequest = result.rows[0]

const pictureKeys = await Promise.all(
  pictures.map((picture, index) => {
    const key = createPurchaseRequestPictureKey(
      createdRequest.id,
      picture,
      index
    )

    return uploadBufferToS3({
      key,
      buffer: picture.buffer,
      contentType: picture.mimetype,
    })
  })
)

if (pictureKeys.length > 0) {
  const updatedRequestResult = await client.query(
    `
    UPDATE portal.purchase_requests
    SET picture_keys = $1
    WHERE id = $2
    RETURNING *
    `,
    [pictureKeys, createdRequest.id]
  )
 
  createdRequest = updatedRequestResult.rows[0]
}

const buyerValidationToken = await createBuyerValidationToken(client, createdRequest.id)
const buyerValidationUrl = buildBuyerValidationUrl(
  req,
  createdRequest.id,
  buyerValidationToken
)

await client.query("COMMIT")

const buyerRecipients = getEmailRecipients(
  "PURCHASE_BUYER_EMAIL",
  "PURCHASE_EMAIL_COPY"
)

const pictureLinks = await buildPictureEmailLinks(pictureKeys, pictures)

await sendPurchaseRequestEmailSafely(
  buyerRecipients,
  `Nouvelle demande d'achat #${createdRequest.id}`,
  buildNewPurchaseRequestEmail(createdRequest, pictureLinks, buyerValidationUrl),
  buildNewPurchaseRequestEmailHtml(createdRequest, pictureLinks, buyerValidationUrl)
)

res.status(201).json(createdRequest)
  } catch (error) {
    await client.query("ROLLBACK")

    console.error("Error creating purchase request:", error)

    res.status(500).json({
      message: "Error creating purchase request",
    })
  } finally {
    client.release()
  }
})


router.patch(
  ["/:id/buyer-validation", "/:id/buyer-validation/:token"],
  actionPurchaseRequestLimiter,
  async (req, res) => {
  const client = await pool.connect()

  try {
    const { id } = req.params
    const purchaseRequestId = Number(id)

    const {
      buyer_user_id,
      buyer_confirmed_unit_price,
      buyer_confirmed_supplier,
      buyer_note,
      needs_requester_info,
      reject,
      rejection_reason,
    } = req.body

    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({ message: "Purchase request not found" })
    }


    const buyerValidationToken = getBuyerValidationTokenFromRequest(req)

    await client.query("BEGIN")

    const isBuyerValidationTokenValid = await validateBuyerValidationToken(
      client,
      purchaseRequestId,
      buyerValidationToken
    )

    if (!isBuyerValidationTokenValid || !buyerValidationToken) {
      await client.query("ROLLBACK")

      return res.status(403).json({
        message: "Invalid or expired buyer validation token",
      })
    }

    const currentRequest = await client.query(
      `
      SELECT *
      FROM portal.purchase_requests
      WHERE id = $1
      `,
      [purchaseRequestId]
    )

    if (currentRequest.rows.length === 0) {
      await client.query("ROLLBACK")

      return res.status(404).json({ message: "Purchase request not found" })
    }

    if (currentRequest.rows[0].status !== "pending_buyer_validation") {
      await client.query("ROLLBACK")

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

    const result = await client.query(
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
        purchaseRequestId,
      ]
    )

    const updatedRequest = result.rows[0]
    const adminApprovalToken =
      updatedRequest.status === "pending_admin_approval"
        ? await createAdminApprovalToken(client, updatedRequest.id)
        : null

    await markBuyerValidationTokenUsed(
      client,
      purchaseRequestId,
      buyerValidationToken
    )

    await client.query("COMMIT")

if (updatedRequest.status === "pending_admin_approval" && adminApprovalToken) {
  const adminRecipients = getEmailRecipients(
    "PURCHASE_BUYER_EMAIL",
    "PURCHASE_EMAIL_COPY"
  )
  const adminApprovalUrl = buildAdminApprovalUrl(
    req,
    updatedRequest.id,
    adminApprovalToken
  )


  await sendPurchaseRequestEmailSafely(
    adminRecipients,
    `Demande d'achat #${updatedRequest.id} prete pour approbation`,
    buildAdminApprovalEmail(updatedRequest, adminApprovalUrl),
    buildAdminApprovalEmailHtml(updatedRequest, adminApprovalUrl)
  )
}

res.json(updatedRequest)
  } catch (error) {
    await client.query("ROLLBACK")

    console.error("Error validating purchase request:", error)
    res.status(500).json({ message: "Error validating purchase request" })
  } finally {
    client.release()
  }
})


router.patch(
  ["/:id/admin-decision", "/:id/admin-decision/:token"],
  actionPurchaseRequestLimiter,
  async (req, res) => {
  const client = await pool.connect()
  try {
    const { id } = req.params
    const purchaseRequestId = Number(id)
    const { admin_user_id, approved, admin_note, rejection_reason } = req.body


    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    if (typeof approved !== "boolean") {
      return res.status(400).json({ message: "La décision est requise" })
    }

    const adminApprovalToken = getAdminApprovalTokenFromRequest(req)

    await client.query("BEGIN")

    const isAdminApprovalTokenValid = await validateAdminApprovalToken(
      client,
      purchaseRequestId,
      adminApprovalToken
    )

    if (!isAdminApprovalTokenValid || !adminApprovalToken) {
      await client.query("ROLLBACK")

      return res.status(403).json({
        message: "Invalid or expired admin approval token",
      })
    }

    const currentRequest = await client.query(
      `
      SELECT *
      FROM portal.purchase_requests
      WHERE id = $1
      `,
      [purchaseRequestId]
    )

    if (currentRequest.rows.length === 0) {
      await client.query("ROLLBACK")

      return res.status(404).json({ message: "Purchase request not found" })
    }

    if (currentRequest.rows[0].status !== "pending_admin_approval") {
      await client.query("ROLLBACK")

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
        admin_user_id || null,
        admin_note || null,
        newStatus,
        approved ? null : rejection_reason || null,
        purchaseRequestId,
      ]
    )

    const updatedRequest = result.rows[0]

    await markAdminApprovalTokenUsed(
      client,
      purchaseRequestId,
      adminApprovalToken
    )

    await client.query("COMMIT")

const buyerRecipients = getEmailRecipients(
  "PURCHASE_BUYER_EMAIL",
  "PURCHASE_EMAIL_COPY"
)

await sendPurchaseRequestEmailSafely(
  buyerRecipients,
  `Décision pour la demande d'achat #${updatedRequest.id}`,
  buildBuyerDecisionEmail(updatedRequest)
)

res.json(updatedRequest)
  } catch (error) {
    await client.query("ROLLBACK")

    console.error("Error saving admin decision:", error)
    res.status(500).json({ message: "Error saving admin decision" })
  } finally {
    client.release()
  }
})

router.patch("/:id/mark-purchased", actionPurchaseRequestLimiter, async (req, res) => {
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


router.patch("/:id/cancel", actionPurchaseRequestLimiter, async (req, res) => {
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
