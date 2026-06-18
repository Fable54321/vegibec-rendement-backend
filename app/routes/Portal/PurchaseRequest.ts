import express from "express"
import { pool } from "../../db"
import crypto from "crypto"
import rateLimit from "express-rate-limit"
import {
  buildAdminApprovalEmail,
  buildAdminApprovalEmailHtml,
  buildBuyerDecisionEmail,
  buildBuyerDecisionEmailHtml,
  buildDirectApprovalBuyerDecisionEmail,
  buildDirectApprovalBuyerDecisionEmailHtml,
  buildRequesterDateChangedEmail,
  buildRequesterDateChangedEmailHtml,
  buildAdminApprovalUrl,
  buildBuyerValidationUrl,
  buildFinalPurchaseRequestUrl,
  buildNewPurchaseRequestEmail,
  buildNewPurchaseRequestEmailHtml,
  buildPictureEmailLinks,
  createAdminApprovalToken,
  createBuyerValidationToken,
  createPurchaseToken,
  createPurchaseRequestPictureKey,
  getAdminApprovalTokenFromRequest,
  getBuyerValidationTokenFromRequest,
  getPurchaseTokenFromRequest,
  getEmailRecipients,
  getPurchaseRequestDisplayNumber,
  getUrgencyFromExpectedDate,
  markAdminApprovalTokenUsed,
  markBuyerValidationTokenUsed,
  sendPurchaseRequestEmailSafely,
  uploadPurchaseRequestPictures,
  validateAdminApprovalToken,
  validateBuyerValidationToken,
  validatePurchaseToken,
} from "../../routes/Portal/Utils/PurchaseHelper"
import { actionPurchaseRequestLimiter } from "../Portal/BuyingRoute"
import { uploadBufferToS3 } from "../../services/s3.services"
import { sendEmail } from "../Visitors/Utils/testSMTP"
import { PoolClient } from "pg"


type PurchaseRequestIncomingItem = {
  description?: unknown
  quantity?: unknown
  quantity_format?: unknown
  reason?: unknown
  requested_unit_price?: unknown
  requested_supplier?: unknown
  product_link?: unknown
}

const MAX_PURCHASE_REQUEST_ITEMS = 25

const parsePurchaseRequestItems = (body: any): PurchaseRequestIncomingItem[] => {
  if (Array.isArray(body.items)) {
    return body.items
  }

  if (typeof body.items === "string" && body.items.trim() !== "") {
    return JSON.parse(body.items)
  }

  // Temporary backward compatibility for the old single-item form.
  return [
    {
      description: body.description,
      quantity: body.quantity,
      quantity_format: body.quantity_format,
      reason: body.reason,
      requested_unit_price: body.requested_unit_price,
      requested_supplier: body.requested_supplier,
      product_link: body.product_link,
    },
  ]
}

const cleanPurchaseRequestItems = (items: PurchaseRequestIncomingItem[]) => {
  if (
    !Array.isArray(items) ||
    items.length < 1 ||
    items.length > MAX_PURCHASE_REQUEST_ITEMS
  ) {
    throw new Error(
      `La demande doit contenir entre 1 et ${MAX_PURCHASE_REQUEST_ITEMS} article(s)`
    )
  }

  return items.map((item, index) => {
    const itemNumber = index + 1

    const cleanDescription =
      typeof item.description === "string" ? item.description.trim() : ""

    const cleanQuantityFormat =
      typeof item.quantity_format === "string" &&
      item.quantity_format.trim() !== ""
        ? item.quantity_format.trim().replace(/\s+/g, " ")
        : null

    const cleanReason =
      typeof item.reason === "string" && item.reason.trim() !== ""
        ? item.reason.trim()
        : null

    const cleanRequestedSupplier =
      typeof item.requested_supplier === "string" &&
      item.requested_supplier.trim() !== ""
        ? item.requested_supplier.trim()
        : null

    const cleanProductLink =
      typeof item.product_link === "string" && item.product_link.trim() !== ""
        ? item.product_link.trim()
        : null

    const cleanQuantity =
      item.quantity === undefined || item.quantity === null || item.quantity === ""
        ? null
        : Number(item.quantity)

    const cleanUnitPrice =
      item.requested_unit_price === "" ||
      item.requested_unit_price === undefined ||
      item.requested_unit_price === null
        ? null
        : Number(item.requested_unit_price)

    if (!cleanDescription) {
      throw new Error(`Article ${itemNumber}: la description est requise`)
    }

    if (cleanDescription.length > 1000) {
      throw new Error(`Article ${itemNumber}: la description est trop longue`)
    }

    if (
      cleanQuantity === null ||
      !Number.isFinite(cleanQuantity) ||
      cleanQuantity <= 0 ||
      !Number.isInteger(cleanQuantity)
    ) {
      throw new Error(
        `Article ${itemNumber}: la quantité doit être un nombre entier supérieur à 0`
      )
    }

    if (cleanQuantityFormat && cleanQuantityFormat.length > 80) {
      throw new Error(`Article ${itemNumber}: le format de quantité est trop long`)
    }

    if (cleanReason && cleanReason.length > 2000) {
      throw new Error(`Article ${itemNumber}: la justification est trop longue`)
    }

    if (cleanRequestedSupplier && cleanRequestedSupplier.length > 200) {
      throw new Error(`Article ${itemNumber}: le fournisseur est trop long`)
    }

    if (cleanProductLink && cleanProductLink.length > 2000) {
      throw new Error(`Article ${itemNumber}: le lien du produit est trop long`)
    }

    if (cleanProductLink) {
      try {
        const url = new URL(cleanProductLink)

        if (!["http:", "https:"].includes(url.protocol)) {
          throw new Error("Invalid protocol")
        }
      } catch {
        throw new Error(`Article ${itemNumber}: le lien du produit est invalide`)
      }
    }

    if (
      cleanUnitPrice !== null &&
      (!Number.isFinite(cleanUnitPrice) || cleanUnitPrice < 0)
    ) {
      throw new Error(`Article ${itemNumber}: le prix doit être un nombre valide`)
    }

    return {
      item_index: itemNumber,
      description: cleanDescription,
      quantity: cleanQuantity,
      quantity_format: cleanQuantityFormat,
      reason: cleanReason,
      requested_unit_price: cleanUnitPrice,
      requested_supplier: cleanRequestedSupplier,
      product_link: cleanProductLink,
    }
  })
}

const router = express.Router()
const TEMP_PURCHASE_REQUEST_RECIPIENT = "programmation@vegibec.com"
const CONFLICT_REQUESTER_EMAIL = "achats@vegibec.com"

type PurchaseRequestRecipientSource = {
  requester_email?: unknown
}

const toRecipientArray = (recipients: string | string[]) => {
  if (Array.isArray(recipients)) {
    return recipients
  }

  return recipients
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)
}

const getPurchaseRequestRecipients = (
  request?: PurchaseRequestRecipientSource
) => {
  const requesterEmail =
    typeof request?.requester_email === "string"
      ? request.requester_email.trim().toLowerCase()
      : ""

  const recipients = toRecipientArray(
    getEmailRecipients(
      "PURCHASE_BUYER_EMAIL",
      "PURCHASE_EMAIL_COPY",
      TEMP_PURCHASE_REQUEST_RECIPIENT
    )
  )

  if (
    requesterEmail &&
    requesterEmail !== CONFLICT_REQUESTER_EMAIL &&
    !recipients.includes(requesterEmail)
  ) {
    recipients.push(requesterEmail)
  }

  return recipients
}

const getPurchaseRequestReplyToRecipients = () => {
  return toRecipientArray(
    getEmailRecipients(
      "PURCHASE_BUYER_EMAIL",
      "PURCHASE_EMAIL_COPY",
      TEMP_PURCHASE_REQUEST_RECIPIENT
    )
  )
}

const VALID_STATUSES = [
  "pending_buyer_validation",
  "needs_requester_info",
  "pending_admin_approval",
  "admin_on_wait",
  "rejected",
  "ready_to_purchase",
  "purchased",
  "cancelled",
]

const MAX_BATCH_PURCHASE_ITEMS = 10
const MAX_PICTURES_PER_BATCH_ITEM = 5

type BatchPurchaseRequestItem = {
  client_item_index?: unknown
  description?: unknown
  quantity?: unknown
  quantity_format?: unknown
  reason?: unknown
  requested_unit_price?: unknown
  product_link?: unknown
  needed_by_date?: unknown
}

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



async function getNextPurchaseRequestReference(client: PoolClient) {
  const result = await client.query<{
    request_reference: string
    request_year: number
    request_month: number
    request_month_sequence: number
  }>(
    `
    SELECT *
    FROM portal.next_purchase_request_reference()
    `
  )

  const row = result.rows[0]

  if (!row) {
    throw new Error("Could not generate purchase request reference")
  }

  return row
}

async function getPurchaseRequestWithItems(
  client: PoolClient,
  purchaseRequestId: number
) {
  const result = await client.query(
    `
    SELECT
      pr.*,
      COALESCE(
        jsonb_agg(
          to_jsonb(pri)
          ORDER BY pri.item_index
        ) FILTER (WHERE pri.id IS NOT NULL),
        '[]'::jsonb
      ) AS items
    FROM portal.purchase_requests pr
    LEFT JOIN portal.purchase_request_items pri
      ON pri.purchase_request_id = pr.id
    WHERE pr.id = $1
    GROUP BY pr.id
    `,
    [purchaseRequestId]
  )

  return result.rows[0] ?? null
}

router.post("/send-email", createPurchaseRequestLimiter, async (req, res) => {
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

    const replyToRecipients = getPurchaseRequestRecipients({
      requester_email: cleanTo,
    })

    const emailInfo = await sendEmail({
      to: cleanTo,
      replyTo: replyToRecipients,
      subject: cleanSubject,
      text: cleanMessage,
      fromLabel: "Vegibec - Demandes d'achat",
    })

    console.log("Purchase request email relay response:", {
      to: cleanTo,
      replyTo: replyToRecipients,
      messageId: emailInfo.messageId,
      accepted: emailInfo.accepted,
      rejected: emailInfo.rejected,
      response: emailInfo.response,
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
    admin.surname AS admin_surname,
    COALESCE(
      jsonb_agg(
        to_jsonb(pri)
        ORDER BY pri.item_index
      ) FILTER (WHERE pri.id IS NOT NULL),
      '[]'::jsonb
    ) AS items
  FROM portal.purchase_requests pr
  LEFT JOIN portal.purchase_request_items pri
    ON pri.purchase_request_id = pr.id
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

    query += `
  GROUP BY
    pr.id,
    buyer.name,
    buyer.surname,
    admin.name,
    admin.surname
  ORDER BY pr.created_at DESC
`

    const result = await pool.query(query, params)

    res.json(result.rows)
  } catch (error) {
    console.error("Error fetching purchase requests:", error)
    res.status(500).json({ message: "Error fetching purchase requests" })
  }
})

// GET /api/purchase-requests/:id
router.get(
  [
    "/:id/buyer-validation/:token",
    "/:id/validation-prix/:token",
    "/:id/admin-decision/:token",
    "/:id/approbation-achat/:token",
    "/:id/mark-purchased/:token",
    "/:id/acheter/:token",
  ],
  readPurchaseRequestsLimiter,
  async (req, res) => {
    try {
      const { id } = req.params
      const purchaseRequestId = Number(id)

      if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
        return res.status(404).json({ message: "Purchase request not found" })
      }

      const isBuyerValidationRoute =
        req.path.includes("/buyer-validation/") ||
        req.path.includes("/validation-prix/")
      const isAdminDecisionRoute =
        req.path.includes("/admin-decision/") ||
        req.path.includes("/approbation-achat/")
      const isMarkPurchasedRoute =
        req.path.includes("/mark-purchased/") ||
        req.path.includes("/acheter/")

      const client = await pool.connect()

      try {
        let isTokenValid = false

        if (isBuyerValidationRoute) {
          isTokenValid = await validateBuyerValidationToken(
            client,
            purchaseRequestId,
            getBuyerValidationTokenFromRequest(req)
          )
        }

        if (isAdminDecisionRoute) {
          isTokenValid = await validateAdminApprovalToken(
            client,
            purchaseRequestId,
            getAdminApprovalTokenFromRequest(req)
          )
        }

        if (isMarkPurchasedRoute) {
          isTokenValid = await validatePurchaseToken(
            client,
            purchaseRequestId,
            getPurchaseTokenFromRequest(req)
          )
        }

        if (!isTokenValid) {
          return res.status(403).json({
            message: "Le lien n'est plus valide",
          })
        }

const purchaseRequest = await getPurchaseRequestWithItems(
  client,
  purchaseRequestId
)

if (!purchaseRequest) {
  return res.status(404).json({ message: "Purchase request not found" })
}

return res.json(purchaseRequest)
      } finally {
        client.release()
      }
    } catch (error) {
      console.error("Error fetching token-protected purchase request:", error)
      return res.status(500).json({ message: "Error fetching purchase request" })
    }
  }
)

router.get("/:id", readPurchaseRequestsLimiter, async (req, res) => {
  try {
    const { id } = req.params

    if (!/^\d+$/.test(id)) {
      return res.status(404).json({ message: "Purchase request not found" })
    }

    const suppliedToken =
      getBuyerValidationTokenFromRequest(req) ||
      getAdminApprovalTokenFromRequest(req) ||
      getPurchaseTokenFromRequest(req)

    if (suppliedToken) {
      const purchaseRequestId = Number(id)
      const client = await pool.connect()

      try {
        const isTokenValid =
          (await validateBuyerValidationToken(
            client,
            purchaseRequestId,
            getBuyerValidationTokenFromRequest(req)
          )) ||
          (await validateAdminApprovalToken(
            client,
            purchaseRequestId,
            getAdminApprovalTokenFromRequest(req)
          )) ||
          (await validatePurchaseToken(
            client,
            purchaseRequestId,
            getPurchaseTokenFromRequest(req)
          ))

        if (!isTokenValid) {
          return res.status(403).json({
            message: "Le lien n'est plus valide",
          })
        }
      } finally {
        client.release()
      }
    }

const client = await pool.connect()

try {
  const purchaseRequest = await getPurchaseRequestWithItems(client, Number(id))

  if (!purchaseRequest) {
    return res.status(404).json({ message: "Purchase request not found" })
  }

  res.json(purchaseRequest)
} finally {
  client.release()
}
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
        needed_by_date,
        companyWebsite,
        email,
      } = body

      if (companyWebsite) {
        return res.status(400).json({ message: "Invalid request" })
      }

      const cleanRequestedBy =
        typeof requested_by === "string" ? requested_by.trim() : ""

      const cleanRequesterEmail =
        typeof email === "string" && email.trim() !== ""
          ? email.trim().toLowerCase()
          : null

      const cleanNeededByDate =
        typeof needed_by_date === "string" && needed_by_date.trim() !== ""
          ? needed_by_date.trim()
          : null

      if (!cleanRequestedBy) {
        return res.status(400).json({
          message: "Le demandeur est requis",
        })
      }

      if (cleanRequestedBy.length > 150) {
        return res.status(400).json({
          message: "Le nom du demandeur est trop long",
        })
      }

      if (cleanRequesterEmail && cleanRequesterEmail.length > 254) {
        return res.status(400).json({
          message: "L'adresse courriel est trop longue",
        })
      }

      if (
        cleanRequesterEmail &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanRequesterEmail)
      ) {
        return res.status(400).json({
          message: "L'adresse courriel est invalide",
        })
      }

      if (cleanNeededByDate) {
        const date = new Date(`${cleanNeededByDate}T00:00:00`)

        if (
          Number.isNaN(date.getTime()) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(cleanNeededByDate)
        ) {
          return res.status(400).json({
            message: "La date souhaitée est invalide",
          })
        }
      }

      let parsedItems: PurchaseRequestIncomingItem[]

      try {
        parsedItems = parsePurchaseRequestItems(body)
      } catch {
        return res.status(400).json({
          message: "La liste des articles est invalide",
        })
      }

      let cleanedItems: ReturnType<typeof cleanPurchaseRequestItems>

      try {
        cleanedItems = cleanPurchaseRequestItems(parsedItems)
      } catch (error) {
        return res.status(400).json({
          message:
            error instanceof Error
              ? error.message
              : "La liste des articles est invalide",
        })
      }

      const urgency = getUrgencyFromExpectedDate(cleanNeededByDate)
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

      const requestReference = await getNextPurchaseRequestReference(client)

      const requestResult = await client.query(
        `
        INSERT INTO portal.purchase_requests (
          request_reference,
          request_year,
          request_month,
          request_month_sequence,
          requested_by,
          requester_email,
          urgency,
          needed_by_date,
          status
        )
        VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          'pending_buyer_validation'
        )
        RETURNING *
        `,
        [
          requestReference.request_reference,
          requestReference.request_year,
          requestReference.request_month,
          requestReference.request_month_sequence,
          cleanRequestedBy,
          cleanRequesterEmail,
          urgency,
          cleanNeededByDate,
        ]
      )

      let createdRequest = requestResult.rows[0]

      const insertedItemsResult = await client.query(
        `
        INSERT INTO portal.purchase_request_items (
          purchase_request_id,
          item_index,
          description,
          reason,
          quantity,
          quantity_format,
          requested_unit_price,
          requested_supplier,
          product_link,
          status
        )
        SELECT
          $1,
          item_index,
          description,
          reason,
          quantity,
          quantity_format,
          requested_unit_price,
          requested_supplier,
          product_link,
          'pending_buyer_validation'
        FROM jsonb_to_recordset($2::jsonb) AS item (
          item_index INTEGER,
          description TEXT,
          reason TEXT,
          quantity NUMERIC,
          quantity_format TEXT,
          requested_unit_price NUMERIC,
          requested_supplier TEXT,
          product_link TEXT
        )
        RETURNING *
        `,
        [createdRequest.id, JSON.stringify(cleanedItems)]
      )

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

      const createdRequestWithItems = {
        ...createdRequest,
        items: insertedItemsResult.rows,
      }

      const pictureLinks = await buildPictureEmailLinks(pictureKeys, pictures)
      const displayRequestNumber =
        getPurchaseRequestDisplayNumber(createdRequestWithItems)
      const emailRecipients = getPurchaseRequestRecipients(createdRequestWithItems)

      await sendPurchaseRequestEmailSafely(
        emailRecipients,
        `Ricardo - nouvelle demande d'achat #${displayRequestNumber} à valider`,
        buildNewPurchaseRequestEmail(
          createdRequestWithItems,
          pictureLinks,
          buyerValidationUrl
        ),
        buildNewPurchaseRequestEmailHtml(
          createdRequestWithItems,
          pictureLinks,
          buyerValidationUrl
        )
      )

      return res.status(201).json(createdRequestWithItems)
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
  createPurchaseRequestLimiter,
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
  expected_date,
  direct_approval_requested,
  direct_approval_approver,
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

const cleanDirectApprovalRequested = direct_approval_requested === true
const cleanDirectApprovalApprover =
  cleanDirectApprovalRequested &&
  typeof direct_approval_approver === "string" &&
  direct_approval_approver.trim()
    ? direct_approval_approver.trim()
    : null

    let newStatus = cleanDirectApprovalRequested
      ? "ready_to_purchase"
      : "pending_admin_approval"

    if (needs_requester_info) {
      newStatus = "needs_requester_info"
    }

    if (reject) {
      newStatus = "rejected"
    }

    const quantity = Number(currentRequest.rows[0].quantity || 1)

const cleanExpectedDate =
  typeof expected_date === "string" && expected_date.trim()
    ? expected_date.trim()
    : null

const cleanNeededByDate = currentRequest.rows[0].needed_by_date
  ? new Date(currentRequest.rows[0].needed_by_date).toISOString().slice(0, 10)
  : null

const finalExpectedDate = cleanExpectedDate || cleanNeededByDate

const dateChanged =
  finalExpectedDate !== null &&
  cleanNeededByDate !== null &&
  finalExpectedDate !== cleanNeededByDate

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
    rejection_reason = $7,
    expected_date = $8,
    date_changed = $9,
    direct_approval_requested = $10,
    direct_approval_approver = $11,
    direct_approval_requested_at = CASE WHEN $10 THEN now() ELSE NULL END
  WHERE id = $12
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
    finalExpectedDate,
    dateChanged,
    cleanDirectApprovalRequested,
    cleanDirectApprovalApprover,
    purchaseRequestId,
  ]
)

    const updatedRequest = result.rows[0]
    const adminApprovalToken =
      updatedRequest.status === "pending_admin_approval"
        ? await createAdminApprovalToken(client, updatedRequest.id)
        : null
    const purchaseToken =
      updatedRequest.status === "ready_to_purchase"
        ? await createPurchaseToken(client, updatedRequest.id)
        : null

    await markBuyerValidationTokenUsed(
      client,
      purchaseRequestId,
      buyerValidationToken
    )

    await client.query("COMMIT")

if (updatedRequest.status === "pending_admin_approval" && adminApprovalToken) {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(updatedRequest)
  const emailRecipients = getPurchaseRequestRecipients(updatedRequest)
  const adminApprovalUrl = buildAdminApprovalUrl(
    req,
    updatedRequest.id,
    adminApprovalToken
  )


  await sendPurchaseRequestEmailSafely(
    emailRecipients,
    `Michelle - décision requise pour la demande d'achat #${displayRequestNumber}`,
    buildAdminApprovalEmail(updatedRequest, adminApprovalUrl),
    buildAdminApprovalEmailHtml(updatedRequest, adminApprovalUrl)
  )
}

if (updatedRequest.status === "ready_to_purchase" && purchaseToken) {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(updatedRequest)
  const emailRecipients = getPurchaseRequestRecipients(updatedRequest)
  const finalRequestUrl = buildFinalPurchaseRequestUrl(
    req,
    updatedRequest.id,
    purchaseToken
  )

  await sendPurchaseRequestEmailSafely(
    emailRecipients,
    `Ricardo - APPROBATION DIRECTE - demande d'achat #${displayRequestNumber}, achat a faire`,
    buildDirectApprovalBuyerDecisionEmail(updatedRequest, finalRequestUrl),
    buildDirectApprovalBuyerDecisionEmailHtml(updatedRequest, finalRequestUrl)
  )
}

const requesterEmail =
  typeof updatedRequest.request_email === "string"
    ? updatedRequest.request_email.trim()
    : ""

if (updatedRequest.date_changed && requesterEmail) {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(updatedRequest)

  await sendPurchaseRequestEmailSafely(
    requesterEmail,
    `Mise a jour de la date pour votre demande d'achat #${displayRequestNumber}`,
    buildRequesterDateChangedEmail(updatedRequest),
    buildRequesterDateChangedEmailHtml(updatedRequest),
    getPurchaseRequestReplyToRecipients()
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

      const { decision, admin_note, rejection_reason } = req.body ?? {}

      if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
        return res.status(404).json({ message: "Purchase request not found" })
      }

      const validDecisions = ["approved", "rejected", "on_wait"]

      if (!validDecisions.includes(decision)) {
        return res.status(400).json({ message: "La décision est requise" })
      }

      if (decision === "rejected" && !String(rejection_reason || "").trim()) {
        return res.status(400).json({
          message: "La raison du refus est requise",
        })
      }

      if (decision === "on_wait" && !String(admin_note || "").trim()) {
        return res.status(400).json({
          message: "La raison de la mise en attente est requise",
        })
      }

      const adminApprovalToken = getAdminApprovalTokenFromRequest(req)

      await client.query("BEGIN")

      const isAdminApprovalTokenValid = await validateAdminApprovalToken(
        client,
        purchaseRequestId,
        adminApprovalToken,
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
        [purchaseRequestId],
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

      const newStatus =
        decision === "approved"
          ? "ready_to_purchase"
          : decision === "rejected"
            ? "rejected"
            : "admin_on_wait"

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
          decision === "rejected" ? rejection_reason.trim() : null,
          purchaseRequestId,
        ],
      )

      const updatedRequest = result.rows[0]

      const purchaseToken =
        updatedRequest.status === "ready_to_purchase"
          ? await createPurchaseToken(client, updatedRequest.id)
          : null

      await markAdminApprovalTokenUsed(
        client,
        purchaseRequestId,
        adminApprovalToken,
      )

      await client.query("COMMIT")

      const finalRequestUrl =
  purchaseToken && updatedRequest.status === "ready_to_purchase"
    ? buildFinalPurchaseRequestUrl(
        req,
        updatedRequest.id,
        purchaseToken,
      )
    : null

      const displayRequestNumber =
        getPurchaseRequestDisplayNumber(updatedRequest)

      const emailRecipients = getPurchaseRequestRecipients(updatedRequest)

      if (decision === "approved" || decision === "rejected") {
        await sendPurchaseRequestEmailSafely(
          emailRecipients,
          decision === "approved"
            ? `Ricardo - demande d'achat #${displayRequestNumber} approuvée, achat à faire`
            : `Ricardo - demande d'achat #${displayRequestNumber} refusée`,
          buildBuyerDecisionEmail(updatedRequest, finalRequestUrl),
          buildBuyerDecisionEmailHtml(updatedRequest, finalRequestUrl),
        )
      }

      if (decision === "on_wait") {
        await sendPurchaseRequestEmailSafely(
          emailRecipients,
          `Ricardo - demande d'achat #${displayRequestNumber} mise en attente`,
          `La demande d'achat #${displayRequestNumber} a été mise en attente par Michelle.

Produit :
${updatedRequest.description}

Raison :
${updatedRequest.admin_note || "Aucune raison indiquée"}`,
        )
      }

      const requesterEmail =
        typeof updatedRequest.request_email === "string"
          ? updatedRequest.request_email.trim()
          : ""

      if (requesterEmail) {
        const requesterMessage =
          decision === "approved"
            ? `Votre demande d'achat a été approuvée par Michelle et est maintenant entre les mains de Ricardo pour l'achat du produit :\n${updatedRequest.description}`
            : decision === "rejected"
              ? `Votre demande d'achat a été refusée par Michelle pour le produit :\n${updatedRequest.description}\n\nRaison du refus :\n${
                  updatedRequest.rejection_reason || "Aucune raison indiquée"
                }`
              : `Votre demande d'achat a été mise en attente par Michelle pour le produit :\n${updatedRequest.description}\n\nRaison :\n${
                  updatedRequest.admin_note || "Aucune raison indiquée"
                }`

        await sendPurchaseRequestEmailSafely(
          requesterEmail,
          `Réponse à votre demande d'achat`,
          requesterMessage,
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
  },
)




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
