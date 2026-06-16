import express from "express"
import { pool } from "../../db"
import crypto from "crypto"
import rateLimit from "express-rate-limit"
import {
  buildAdminApprovalEmail,
  buildAdminApprovalEmailHtml,
  buildBuyerDecisionEmail,
  buildBuyerDecisionEmailHtml,
  buildAdminApprovalUrl,
  buildBuyerValidationUrl,
  buildFinalPurchaseRequestUrl,
  buildNewPurchaseRequestEmail,
  buildNewPurchaseRequestEmailHtml,
  buildPictureEmailLinks,
  createAdminApprovalToken,
  createBuyerValidationToken,
  createPurchaseToken,
  createPurchaseRequestDocumentKey,
  createPurchaseRequestPictureKey,
  getAdminApprovalTokenFromRequest,
  getBuyerValidationTokenFromRequest,
  getPurchaseTokenFromRequest,
  getUrgencyFromExpectedDate,
  markAdminApprovalTokenUsed,
  markBuyerValidationTokenUsed,
  markPurchaseTokenUsed,
  sendPurchaseRequestEmailSafely,
  uploadPurchaseRequestDocuments,
  uploadPurchaseRequestPictures,
  validateAdminApprovalToken,
  validateBuyerValidationToken,
  validatePurchaseToken,
} from "../../routes/Portal/Utils/PurchaseHelper"
import { uploadBufferToS3 } from "../../services/s3.services"
import { sendEmail } from "../Visitors/Utils/testSMTP"

const router = express.Router()
const TEMP_PURCHASE_REQUEST_RECIPIENT = "programmation@vegibec.com"

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

router.post("/send-email", actionPurchaseRequestLimiter, async (req, res) => {
  try {
    const { to, subject, message } = req.body ?? {}

    const cleanTo = typeof to === "string" ? to.trim() : ""
    const cleanSubject = typeof subject === "string" ? subject.trim() : ""
    const cleanMessage = typeof message === "string" ? message.trim() : ""

    if (!cleanTo || !cleanSubject || !cleanMessage) {
      return res.status(400).json({
        message: "to, subject and message are required",
      })
    }

    await sendEmail({
      to: cleanTo,
      subject: cleanSubject,
      text: cleanMessage,
      fromLabel: "Vegibec - Demandes d'achat",
    })

    res.status(200).json({ message: "Email sent successfully" })
  } catch (error) {
    console.error("Error sending purchase request email:", error)
    res.status(500).json({ message: "Error sending email" })
  }
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
  SELECT pr.*
  FROM portal.purchase_requests pr
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
    let transactionStarted = false

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
        email,
      } = body

      if (companyWebsite) {
        return res.status(400).json({ message: "Invalid request" })
      }

      const cleanRequestedBy =
        typeof requested_by === "string" ? requested_by.trim() : ""

      const cleanDescription =
        typeof description === "string" ? description.trim() : ""

      const cleanReason =
        typeof reason === "string" && reason.trim() !== ""
          ? reason.trim()
          : null

      const cleanRequestedSupplier =
        typeof requested_supplier === "string" &&
        requested_supplier.trim() !== ""
          ? requested_supplier.trim()
          : null

      const cleanProductLink =
        typeof product_link === "string" && product_link.trim() !== ""
          ? product_link.trim()
          : null

      const cleanExpectedDate =
        typeof expected_date === "string" && expected_date.trim() !== ""
          ? expected_date.trim()
          : null

      // Email is optional.
      // Null, undefined, and empty string are accepted and saved as null.
      const cleanRequestEmail =
        typeof email === "string" && email.trim() !== ""
          ? email.trim().toLowerCase()
          : null

      if (!cleanRequestedBy || !cleanDescription) {
        return res.status(400).json({
          message: "Le demandeur et la description du produit sont requis",
        })
      }

      if (cleanRequestedBy.length > 150) {
        return res.status(400).json({
          message: "Le nom du demandeur est trop long",
        })
      }

      if (cleanDescription.length > 1000) {
        return res.status(400).json({
          message: "La description est trop longue",
        })
      }

      if (cleanReason && cleanReason.length > 2000) {
        return res.status(400).json({
          message: "La justification est trop longue",
        })
      }

      if (cleanRequestedSupplier && cleanRequestedSupplier.length > 200) {
        return res.status(400).json({
          message: "Le fournisseur est trop long",
        })
      }

      if (cleanProductLink && cleanProductLink.length > 2000) {
        return res.status(400).json({
          message: "Le lien du produit est trop long",
        })
      }

      if (cleanRequestEmail && cleanRequestEmail.length > 254) {
        return res.status(400).json({
          message: "L'adresse courriel est trop longue",
        })
      }

      if (
        cleanRequestEmail &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanRequestEmail)
      ) {
        return res.status(400).json({
          message: "L'adresse courriel est invalide",
        })
      }

      if (cleanProductLink) {
        try {
          const url = new URL(cleanProductLink)

          if (!["http:", "https:"].includes(url.protocol)) {
            return res.status(400).json({
              message: "Le lien du produit doit commencer par http ou https",
            })
          }
        } catch {
          return res.status(400).json({
            message: "Le lien du produit est invalide",
          })
        }
      }

      const cleanQuantity =
        quantity === undefined || quantity === null || quantity === ""
          ? 1
          : Number(quantity)

      if (
        !Number.isFinite(cleanQuantity) ||
        cleanQuantity <= 0 ||
        !Number.isInteger(cleanQuantity)
      ) {
        return res.status(400).json({
          message: "La quantité doit être un nombre entier supérieur à 0",
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

      if (cleanExpectedDate) {
        const date = new Date(`${cleanExpectedDate}T00:00:00`)

        if (
          Number.isNaN(date.getTime()) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(cleanExpectedDate)
        ) {
          return res.status(400).json({
            message: "La date souhaitée est invalide",
          })
        }
      }

      const requestedTotalPrice =
        cleanUnitPrice !== null ? cleanUnitPrice * cleanQuantity : null

      const urgency = getUrgencyFromExpectedDate(cleanExpectedDate)
      const formToken = (req as any).purchaseRequestFormToken

      await client.query("BEGIN")
      transactionStarted = true

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
        transactionStarted = false

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
          status,
          request_email
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          'pending_buyer_validation', $11
        )
        RETURNING *
        `,
        [
          cleanRequestedBy,
          cleanDescription,
          cleanQuantity,
          cleanReason,
          urgency,
          cleanUnitPrice,
          requestedTotalPrice,
          cleanRequestedSupplier,
          cleanProductLink,
          cleanExpectedDate,
          cleanRequestEmail,
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

      const buyerValidationToken = await createBuyerValidationToken(
        client,
        createdRequest.id
      )

      const buyerValidationUrl = buildBuyerValidationUrl(
        req,
        createdRequest.id,
        buyerValidationToken
      )

      await client.query("COMMIT")
      transactionStarted = false

      const pictureLinks = await buildPictureEmailLinks(pictureKeys, pictures)

      await sendPurchaseRequestEmailSafely(
        TEMP_PURCHASE_REQUEST_RECIPIENT,
        `Ricardo - nouvelle demande d'achat #${createdRequest.id} à valider`,
        buildNewPurchaseRequestEmail(
          createdRequest,
          pictureLinks,
          buyerValidationUrl
        ),
        buildNewPurchaseRequestEmailHtml(
          createdRequest,
          pictureLinks,
          buyerValidationUrl
        )
      )

      return res.status(201).json(createdRequest)
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK")
      }

      console.error("Error creating purchase request:", error)

      return res.status(500).json({
        message: "Error creating purchase request",
      })
    } finally {
      client.release()
    }
  }
)


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
  const adminApprovalUrl = buildAdminApprovalUrl(
    req,
    updatedRequest.id,
    adminApprovalToken
  )


  await sendPurchaseRequestEmailSafely(
    TEMP_PURCHASE_REQUEST_RECIPIENT,
    `Michelle - décision requise pour la demande d'achat #${updatedRequest.id}`,
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
    const {  approved, admin_note, rejection_reason } = req.body


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

    const result = await client.query(
      `
      UPDATE portal.purchase_requests
      SET
        admin_decision_at = now(),
        admin_note = $1,
        status = $2,
        rejection_reason = $3
      WHERE id = $4
      RETURNING *
      `,
      [
        admin_note || null,
        newStatus,
        approved ? null : rejection_reason || null,
        purchaseRequestId,
      ]
    )

    const updatedRequest = result.rows[0]
    const purchaseToken =
      updatedRequest.status === "ready_to_purchase"
        ? await createPurchaseToken(client, updatedRequest.id)
        : null

    await markAdminApprovalTokenUsed(
      client,
      purchaseRequestId,
      adminApprovalToken
    )

    await client.query("COMMIT")

const finalRequestUrl = buildFinalPurchaseRequestUrl(
  req,
  updatedRequest.id,
  purchaseToken
)

await sendPurchaseRequestEmailSafely(
  TEMP_PURCHASE_REQUEST_RECIPIENT,
  approved
    ? `Ricardo - demande d'achat #${updatedRequest.id} approuvée, achat à faire`
    : `Ricardo - demande d'achat #${updatedRequest.id} refusée`,
  buildBuyerDecisionEmail(updatedRequest, finalRequestUrl),
  buildBuyerDecisionEmailHtml(updatedRequest, finalRequestUrl)
)

const requesterEmail =
  typeof updatedRequest.request_email === "string"
    ? updatedRequest.request_email.trim()
    : ""

if (requesterEmail) {
  const requesterMessage = approved
    ? `Votre demande d'achat a été approuvée par Michelle et est maintenant entre les mains de Ricardo pour l'achat du produit :\n${updatedRequest.description}`
    : `Votre demande d'achat a été refusée par Michelle pour le produit :\n${updatedRequest.description}\n\nRaison du refus :\n${
        updatedRequest.rejection_reason || "Aucune raison indiquée"
      }`

  await sendPurchaseRequestEmailSafely(
    requesterEmail,
    `Réponse à votre demande d'achat`,
    requesterMessage
  )
}

res.json(updatedRequest)
  } catch (error) {
    await client.query("ROLLBACK")

    console.error("Error saving admin decision:", error)
    res.status(500).json({ message: "Error saving admin decision" })
  } finally {
    client.release()
  }
})

router.patch(
  ["/:id/mark-purchased", "/:id/mark-purchased/:token"],
  actionPurchaseRequestLimiter,
  uploadPurchaseRequestDocuments.array("purchase_documents", 5),
  async (req, res) => {
  const client = await pool.connect()

  try {
    const { id } = req.params
    const purchaseRequestId = Number(id)

    const {
      final_unit_price,
      final_supplier,
      purchase_reference,
      purchase_note,
    } = req.body ?? {}
    const purchaseDocuments = (req.files as Express.Multer.File[]) ?? []

    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    const purchaseToken = getPurchaseTokenFromRequest(req)

    await client.query("BEGIN")

    const isPurchaseTokenValid = await validatePurchaseToken(
      client,
      purchaseRequestId,
      purchaseToken
    )

    if (!isPurchaseTokenValid || !purchaseToken) {
      await client.query("ROLLBACK")

      return res.status(403).json({
        message: "Invalid or expired purchase token",
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

    if (currentRequest.rows[0].status !== "ready_to_purchase") {
      await client.query("ROLLBACK")

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

    const purchaseDocumentKeys = await Promise.all(
      purchaseDocuments.map((document, index) => {
        const key = createPurchaseRequestDocumentKey(
          purchaseRequestId,
          document,
          index
        )

        return uploadBufferToS3({
          key,
          buffer: document.buffer,
          contentType: document.mimetype,
        })
      })
    )

    const result = await client.query(
      `
      UPDATE portal.purchase_requests
      SET
        final_unit_price = $1,
        final_total_price = $2,
        purchased_at = now(),
        purchase_reference = $3,
        purchase_note = $4,
        final_supplier = $5,
        purchase_document_keys = $6,
        status = 'purchased'
      WHERE id = $7
      RETURNING *
      `,
      [
        cleanFinalUnitPrice,
        finalTotalPrice,
        purchase_reference || null,
        purchase_note || null,
        final_supplier || null,
        purchaseDocumentKeys,
        purchaseRequestId,
      ]
    )

    await markPurchaseTokenUsed(client, purchaseRequestId, purchaseToken)

    await client.query("COMMIT")

    res.json(result.rows[0])
  } catch (error) {
    await client.query("ROLLBACK")

    console.error("Error marking purchase request as purchased:", error)
    res.status(500).json({ message: "Error marking purchase request as purchased" })
  } finally {
    client.release()
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
