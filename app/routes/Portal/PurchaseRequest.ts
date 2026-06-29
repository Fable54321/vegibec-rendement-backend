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
  buildRequesterDecisionEmail,
  buildRequesterDecisionEmailHtml,
  buildPurchaseRequestCancelledEmail,
  buildPurchaseRequestCancelledEmailHtml,
  buildPurchaseRequestModifiedEmail,
  buildPurchaseRequestModifiedEmailHtml,
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
  getReceiptVoucherTokenFromRequest,
  getPurchaseTokenFromRequest,
  getEmailRecipients,
  getPurchaseRequestDisplayNumber,
  getUrgencyFromExpectedDate,
  invalidateBuyerValidationTokens,
  markAdminApprovalTokenUsed,
  markBuyerValidationTokenUsed,
  sendPurchaseRequestEmailSafely,
  uploadPurchaseRequestPictures,
  validateAdminApprovalToken,
  validateBuyerValidationToken,
  validatePurchaseToken,
  validateReceiptVoucherToken,
  getPurchaseRequestStatusLabel,
} from "../../routes/Portal/Utils/PurchaseHelper"
import { actionPurchaseRequestLimiter } from "../Portal/Utils/purchaseRequestLimiters"
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

const MAX_PURCHASE_REQUEST_ITEMS = 10

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
  "partially_purchased",
  "purchased",
  "partially_received",
  "received",
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

type EditableRequestCheck = {
  id: number
  status: string
  requester_email: string | null
  purchase_order_count: number
}

async function getEditableRequestForEmail(
  client: PoolClient,
  purchaseRequestId: number,
  requesterEmail: string,
): Promise<EditableRequestCheck | null> {
  const result = await client.query(
    `
    SELECT
      pr.id,
      pr.status,
      pr.requester_email,
      EXISTS (
        SELECT 1
        FROM portal.purchase_orders po
        WHERE po.purchase_request_id = pr.id
      ) AS has_purchase_order
    FROM portal.purchase_requests pr
    WHERE pr.id = $1
    AND LOWER(pr.requester_email) = $2
    FOR UPDATE
    `,
    [purchaseRequestId, requesterEmail.trim().toLowerCase()],
  )

  if (result.rows.length === 0) {
    return null
  }

  return {
    id: Number(result.rows[0].id),
    status: result.rows[0].status,
    requester_email: result.rows[0].requester_email,
    purchase_order_count: result.rows[0].has_purchase_order ? 1 : 0,
  }
}

function assertRequesterCanEdit(request: EditableRequestCheck) {
  if (
    request.status === "cancelled" ||
    request.status === "rejected" ||
    request.status === "purchased" ||
    request.status === "partially_purchased" ||
    request.status === "partially_received" ||
    request.status === "received"
  ) {
    return "This request can no longer be modified"
  }

  if (request.purchase_order_count > 0) {
    return "This request can no longer be modified because a purchase order has already been created"
  }

  return null
}



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

export async function getPurchaseRequestWithItems(
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

  const purchaseRequest = result.rows[0] ?? null

  if (!purchaseRequest) return null

  const purchaseOrdersResult = await client.query(
    `
    SELECT
      po.id,
      po.purchase_request_id,
      po.purchase_order_reference,
      po.purchase_order_sequence,
      po.purchase_order_subsequence,
      po.supplier_id,
      po.supplier,
      po.supplier_name,
      po.supplier_address_snapshot,
      po.supplier_phone,
      po.supplier_reference,
      po.purchase_note,
      po.status,
      po.created_at,
      po.updated_at,
      po.purchased_at
    FROM portal.purchase_orders po
    WHERE po.purchase_request_id = $1
    ORDER BY po.purchase_order_sequence ASC, po.purchase_order_subsequence ASC NULLS FIRST, po.id ASC
    `,
    [purchaseRequestId],
  )

  const purchaseOrderIds = purchaseOrdersResult.rows.map((order) => order.id)
  let purchaseOrderItemsByOrderId: Record<number, any[]> = {}

  if (purchaseOrderIds.length > 0) {
    const purchaseOrderItemsResult = await client.query(
      `
      SELECT
        poi.id,
        poi.purchase_order_id,
        poi.purchase_request_item_id,
        poi.item_code,
        poi.item_description,
        poi.ordered_quantity,
        poi.ordered_unit,
        poi.final_unit_price,
        poi.final_total_price,
        poi.number_of_pallets,
        poi.location,
        COALESCE(received.received_quantity, 0)::numeric
          AS already_received_quantity,
        GREATEST(
          poi.ordered_quantity - COALESCE(received.received_quantity, 0),
          0
        )::numeric AS remaining_quantity
      FROM portal.purchase_order_items poi
      LEFT JOIN (
        SELECT
          purchase_order_item_id,
          SUM(received_quantity)::numeric AS received_quantity
        FROM portal.receipt_voucher_items
        WHERE purchase_order_item_id IS NOT NULL
        GROUP BY purchase_order_item_id
      ) received
        ON received.purchase_order_item_id = poi.id
      WHERE poi.purchase_order_id = ANY($1::int[])
      ORDER BY poi.purchase_order_id ASC, poi.id ASC
      `,
      [purchaseOrderIds],
    )

    purchaseOrderItemsByOrderId = purchaseOrderItemsResult.rows.reduce(
      (acc, item) => {
        if (!acc[item.purchase_order_id]) {
          acc[item.purchase_order_id] = []
        }

        acc[item.purchase_order_id].push(item)

        return acc
      },
      {} as Record<number, any[]>,
    )
  }

  const purchaseOrders = purchaseOrdersResult.rows.map((order) => ({
    ...order,
    items: purchaseOrderItemsByOrderId[order.id] ?? [],
  }))

  return {
    ...purchaseRequest,
    purchase_orders: purchaseOrders,
    receipt_voucher_defaults: {
      suppliers: purchaseOrders.map((order) => ({
        purchase_order_id: order.id,
        purchase_order_reference: order.purchase_order_reference,
        supplier_id: order.supplier_id,
        supplier: order.supplier,
        supplier_name: order.supplier_name,
        supplier_address_snapshot: order.supplier_address_snapshot,
        supplier_phone: order.supplier_phone,
        supplier_reference: order.supplier_reference,
      })),
      items: purchaseOrders.flatMap((order) =>
        order.items
          .filter((item: any) => Number(item.remaining_quantity || 0) > 0)
          .map((item: any) => ({
            purchase_request_item_id: item.purchase_request_item_id,
            purchase_order_item_id: item.id,
            purchase_order_id: order.id,
            purchase_order_reference: order.purchase_order_reference,
            supplier_id: order.supplier_id,
            supplier_name: order.supplier_name,
            item_code: item.item_code,
            item_description: item.item_description,
            quantity: item.ordered_quantity,
            received_quantity: item.remaining_quantity,
            ordered_quantity: item.ordered_quantity,
            already_received_quantity: item.already_received_quantity,
            remaining_quantity: item.remaining_quantity,
            ordered_unit: item.ordered_unit,
            number_of_pallets: item.number_of_pallets,
            location: item.location,
          })),
      ),
    },
  }
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

router.get("/editable-by-email", async (req, res) => {
  try {
    const email = typeof req.query.email === "string"
      ? req.query.email.trim().toLowerCase()
      : ""

    if (!email) {
      return res.status(400).json({
        message: "Email is required",
      })
    }

    const result = await pool.query(
      `
      SELECT
        pr.id,
        pr.request_reference,
        pr.requested_by,
        pr.requester_email,
        pr.status,
        pr.urgency,
        pr.needed_by_date,
        pr.expected_date,
        pr.requested_at,
        pr.created_at,
        pr.updated_at,
        pr.cancelled_at,

        COALESCE(items.item_count, 0)::int AS item_count,

        COALESCE(items.requested_total_price, 0)::numeric
          AS requested_total_price,

        first_item.description AS description

      FROM portal.purchase_requests pr

      LEFT JOIN (
        SELECT
          purchase_request_id,
          COUNT(*)::int AS item_count,
          COALESCE(SUM(requested_total_price), 0)::numeric
            AS requested_total_price
        FROM portal.purchase_request_items
        GROUP BY purchase_request_id
      ) items
        ON items.purchase_request_id = pr.id

      LEFT JOIN (
        SELECT DISTINCT ON (purchase_request_id)
          purchase_request_id,
          description
        FROM portal.purchase_request_items
        ORDER BY purchase_request_id, item_index ASC, id ASC
      ) first_item
        ON first_item.purchase_request_id = pr.id

      WHERE LOWER(pr.requester_email) = $1

      AND pr.status NOT IN (
        'cancelled',
        'rejected',
        'purchased',
        'partially_purchased',
        'partially_received',
        'received'
      )

      AND NOT EXISTS (
        SELECT 1
        FROM portal.purchase_orders po
        WHERE po.purchase_request_id = pr.id
      )

      ORDER BY pr.created_at DESC

      LIMIT 5
      `,
      [email],
    )

    const rows = result.rows.map((row) => ({
      ...row,
      id: Number(row.id),
      item_count: Number(row.item_count || 0),
      requested_total_price: Number(row.requested_total_price || 0),
      status_label: getPurchaseRequestStatusLabel(row.status),
      can_modify: true,
      can_cancel: true,
    }))

    return res.json(rows)
  } catch (error) {
    console.error("Editable requests by email error:", error)

    return res.status(500).json({
      message: "Unable to load editable requests",
    })
  }
})

router.get("/:id/editable", readPurchaseRequestsLimiter, async (req, res) => {
  const client = await pool.connect()

  try {
    const purchaseRequestId = Number(req.params.id)

    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const requesterEmail =
      typeof req.query.email === "string"
        ? req.query.email.trim().toLowerCase()
        : ""

    if (!requesterEmail) {
      return res.status(400).json({
        message: "Requester email is required",
      })
    }

    const requestResult = await client.query(
      `
      SELECT
        pr.id,
        pr.request_reference,
        pr.requested_by,
        pr.requester_email,
        pr.status,
        pr.urgency,
        pr.needed_by_date,
        pr.expected_date,
        pr.requested_at,
        pr.created_at,
        pr.updated_at,
        pr.cancelled_at,
        pr.cancellation_reason,
        pr.modified_at,
        pr.modification_reason,

        EXISTS (
          SELECT 1
          FROM portal.purchase_orders po
          WHERE po.purchase_request_id = pr.id
        ) AS has_purchase_order

      FROM portal.purchase_requests pr

      WHERE pr.id = $1
      AND LOWER(pr.requester_email) = $2
      `,
      [purchaseRequestId, requesterEmail],
    )

    if (requestResult.rows.length === 0) {
      return res.status(404).json({
        message: "Editable request not found",
      })
    }

    const request = requestResult.rows[0]

    const hasPurchaseOrder = Boolean(request.has_purchase_order)

    const canEdit =
      !hasPurchaseOrder &&
      ![
        "cancelled",
        "rejected",
        "purchased",
        "partially_purchased",
        "partially_received",
        "received",
      ].includes(request.status)

    if (!canEdit) {
      return res.status(403).json({
        message: "This request can no longer be modified",
      })
    }

    const itemsResult = await client.query(
      `
      SELECT
        pri.id,
        pri.purchase_request_id,
        pri.item_index,
        pri.description,
        pri.reason,
        pri.quantity,
        pri.quantity_format,
        pri.requested_unit_price,
        pri.requested_total_price,
        pri.requested_supplier,
        pri.product_link,
        pri.buyer_confirmed_unit_price,
        pri.buyer_confirmed_total_price,
        pri.buyer_confirmed_supplier,
        pri.status,
        pri.created_at,
        pri.updated_at,
        pri.cancelled_at,
        pri.cancellation_reason,
        pri.modified_at,
        pri.modification_reason,

        EXISTS (
          SELECT 1
          FROM portal.purchase_order_items poi
          WHERE poi.purchase_request_item_id = pri.id
        ) AS has_purchase_order

      FROM portal.purchase_request_items pri

      WHERE pri.purchase_request_id = $1

      ORDER BY pri.item_index ASC, pri.id ASC
      `,
      [purchaseRequestId],
    )

    return res.json({
      request: {
        ...request,
        id: Number(request.id),
        has_purchase_order: hasPurchaseOrder,
        can_modify: canEdit,
        can_cancel: canEdit,
        status_label: getPurchaseRequestStatusLabel(request.status),
      },
      items: itemsResult.rows.map((item) => ({
        ...item,
        id: Number(item.id),
        purchase_request_id: Number(item.purchase_request_id),
        quantity: Number(item.quantity || 0),
        requested_unit_price: Number(item.requested_unit_price || 0),
        requested_total_price: Number(item.requested_total_price || 0),
        buyer_confirmed_unit_price:
          item.buyer_confirmed_unit_price === null
            ? null
            : Number(item.buyer_confirmed_unit_price),
        buyer_confirmed_total_price:
          item.buyer_confirmed_total_price === null
            ? null
            : Number(item.buyer_confirmed_total_price),
        has_purchase_order: Boolean(item.has_purchase_order),
        can_modify: !Boolean(item.has_purchase_order),
      })),
    })
  } catch (error) {
    console.error("Editable purchase request detail error:", error)

    return res.status(500).json({
      message: "Unable to load editable purchase request",
    })
  } finally {
    client.release()
  }
})

router.patch("/:id/editable", async (req, res) => {
  const client = await pool.connect()

  try {
    const purchaseRequestId = Number(req.params.id)

    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const {
      requester_email,
      requested_by,
      needed_by_date,
      modification_reason,
      items,
    } = req.body ?? {}

    const cleanRequesterEmail =
      typeof requester_email === "string"
        ? requester_email.trim().toLowerCase()
        : ""

    if (!cleanRequesterEmail) {
      return res.status(400).json({
        message: "Requester email is required",
      })
    }

    if (
      typeof modification_reason !== "string" ||
      modification_reason.trim().length < 3
    ) {
      return res.status(400).json({
        message: "A modification reason is required",
      })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: "At least one item is required",
      })
    }

    await client.query("BEGIN")

    const request = await getEditableRequestForEmail(
      client,
      purchaseRequestId,
      cleanRequesterEmail,
    )

    if (!request) {
      await client.query("ROLLBACK")

      return res.status(404).json({
        message: "Editable request not found",
      })
    }

    const editError = assertRequesterCanEdit(request)

    if (editError) {
      await client.query("ROLLBACK")

      return res.status(403).json({
        message: editError,
      })
    }

    await client.query(
      `
      UPDATE portal.purchase_requests
      SET
        requested_by = COALESCE($2, requested_by),
        needed_by_date = COALESCE($3, needed_by_date),
        status = 'pending_buyer_validation',
        buyer_user_id = NULL,
        buyer_note = NULL,
        buyer_validated_at = NULL,
        expected_date = COALESCE($3, needed_by_date),
        date_changed = false,
        direct_approval_requested = false,
        direct_approval_approver = NULL,
        direct_approval_requested_at = NULL,
        rejection_reason = NULL,
        modified_at = now(),
        modified_by_name = COALESCE($4, requested_by),
        modified_by_email = $5,
        modification_reason = $6,
        updated_at = now()
      WHERE id = $1
      `,
      [
        purchaseRequestId,
        typeof requested_by === "string" && requested_by.trim()
          ? requested_by.trim()
          : null,
        needed_by_date || null,
        typeof requested_by === "string" && requested_by.trim()
          ? requested_by.trim()
          : null,
        cleanRequesterEmail,
        modification_reason.trim(),
      ],
    )

    for (const item of items) {
      const itemId = Number(item.id)

      if (!Number.isInteger(itemId) || itemId <= 0) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message: "Invalid item id",
        })
      }

      const quantity = Number(item.quantity)
      const requestedUnitPrice = Number(item.requested_unit_price)

      if (!Number.isFinite(quantity) || quantity <= 0) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message: "Invalid item quantity",
        })
      }

      if (!Number.isFinite(requestedUnitPrice) || requestedUnitPrice < 0) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message: "Invalid requested unit price",
        })
      }

      const itemResult = await client.query(
  `
  UPDATE portal.purchase_request_items
  SET
    description = $3,
    reason = $4,
    quantity = $5::int,
    quantity_format = $6,
    requested_unit_price = $7::numeric,
    requested_supplier = $8,
    product_link = $9,
    buyer_confirmed_unit_price = NULL,
    buyer_confirmed_supplier = NULL,
    status = 'pending_buyer_validation',
    modified_at = now(),
    modification_reason = $10,
    updated_at = now()
  WHERE id = $1
  AND purchase_request_id = $2
  AND NOT EXISTS (
    SELECT 1
    FROM portal.purchase_order_items poi
    WHERE poi.purchase_request_item_id = portal.purchase_request_items.id
  )
  RETURNING id
  `,
  [
    itemId,
    purchaseRequestId,
    item.description?.trim() || null,
    item.reason?.trim() || null,
    quantity,
    item.quantity_format?.trim() || null,
    requestedUnitPrice,
    item.requested_supplier?.trim() || null,
    item.product_link?.trim() || null,
    modification_reason.trim(),
  ],
)

      if (itemResult.rows.length === 0) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message: "One of the items cannot be modified",
        })
      }
    }

    await invalidateBuyerValidationTokens(client, purchaseRequestId)

    const buyerValidationToken = await createBuyerValidationToken(
      client,
      purchaseRequestId,
    )

    const updatedRequest = await getPurchaseRequestWithItems(
      client,
      purchaseRequestId,
    )

    if (!updatedRequest) {
      await client.query("ROLLBACK")

      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    await client.query("COMMIT")

    const displayRequestNumber = getPurchaseRequestDisplayNumber(updatedRequest)
    const emailRecipients = getPurchaseRequestRecipients(updatedRequest)
    const buyerValidationUrl = buildBuyerValidationUrl(
      req,
      updatedRequest.id,
      buyerValidationToken,
    )

    await sendPurchaseRequestEmailSafely(
      emailRecipients,
      `Demande d'achat #${displayRequestNumber} modifiée - validation requise`,
      buildPurchaseRequestModifiedEmail(updatedRequest, buyerValidationUrl),
      buildPurchaseRequestModifiedEmailHtml(updatedRequest, buyerValidationUrl),
      getPurchaseRequestReplyToRecipients(),
    )

    return res.json({
      message: "Purchase request modified",
      request: updatedRequest,
    })
  } catch (error) {
    await client.query("ROLLBACK")

    console.error("Editable request modification error:", error)

    return res.status(500).json({
      message: "Unable to modify purchase request",
    })
  } finally {
    client.release()
  }
})

router.delete("/:id/editable", async (req, res) => {
  const client = await pool.connect()

  try {
    const purchaseRequestId = Number(req.params.id)

    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const requesterEmail =
      typeof req.body?.requester_email === "string"
        ? req.body.requester_email.trim().toLowerCase()
        : typeof req.query.email === "string"
          ? req.query.email.trim().toLowerCase()
          : ""

    const cancellationReason =
      typeof req.body?.cancellation_reason === "string"
        ? req.body.cancellation_reason.trim()
        : ""

    if (!requesterEmail) {
      return res.status(400).json({
        message: "Requester email is required",
      })
    }

    if (cancellationReason.length < 3) {
      return res.status(400).json({
        message: "A cancellation reason is required",
      })
    }

    await client.query("BEGIN")

    const request = await getEditableRequestForEmail(
      client,
      purchaseRequestId,
      requesterEmail,
    )

    if (!request) {
      await client.query("ROLLBACK")

      return res.status(404).json({
        message: "Editable request not found",
      })
    }

    const editError = assertRequesterCanEdit(request)

    if (editError) {
      await client.query("ROLLBACK")

      return res.status(403).json({
        message: editError,
      })
    }

    await client.query(
      `
      UPDATE portal.purchase_requests
      SET
        status = 'cancelled',
        cancelled_at = now(),
        cancelled_by_email = $2,
        cancelled_by_name = requested_by,
        cancellation_reason = $3,
        updated_at = now()
      WHERE id = $1
      `,
      [purchaseRequestId, requesterEmail, cancellationReason],
    )

    await client.query(
      `
      UPDATE portal.purchase_request_items
      SET
        status = 'cancelled',
        cancelled_at = now(),
        cancellation_reason = $2,
        updated_at = now()
      WHERE purchase_request_id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM portal.purchase_order_items poi
        WHERE poi.purchase_request_item_id = portal.purchase_request_items.id
      )
      `,
      [purchaseRequestId, cancellationReason],
    )

    const cancelledRequest = await getPurchaseRequestWithItems(
      client,
      purchaseRequestId,
    )

    if (!cancelledRequest) {
      await client.query("ROLLBACK")

      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    await client.query("COMMIT")

    const displayRequestNumber = getPurchaseRequestDisplayNumber(cancelledRequest)
    const emailRecipients = getPurchaseRequestRecipients(cancelledRequest)

    await sendPurchaseRequestEmailSafely(
      emailRecipients,
      `Demande d'achat #${displayRequestNumber} annulée`,
      buildPurchaseRequestCancelledEmail(cancelledRequest),
      buildPurchaseRequestCancelledEmailHtml(cancelledRequest),
      getPurchaseRequestReplyToRecipients(),
    )

    return res.json({
      message: "Purchase request cancelled",
      request: cancelledRequest,
    })
  } catch (error) {
    await client.query("ROLLBACK")

    console.error("Editable request cancellation error:", error)

    return res.status(500).json({
      message: "Unable to cancel purchase request",
    })
  } finally {
    client.release()
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
    "/:id/reception/:token",
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
      const isReceiptVoucherRoute = req.path.includes("/reception/")

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

        if (isReceiptVoucherRoute) {
          isTokenValid = await validateReceiptVoucherToken(
            client,
            purchaseRequestId,
            getReceiptVoucherTokenFromRequest(req)
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
      getPurchaseTokenFromRequest(req) ||
      getReceiptVoucherTokenFromRequest(req)

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
          )) ||
          (await validateReceiptVoucherToken(
            client,
            purchaseRequestId,
            getReceiptVoucherTokenFromRequest(req)
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
    let transactionStarted = false

    try {
      const { id } = req.params
      const purchaseRequestId = Number(id)

      const {
        buyer_user_id,
        buyer_note,
        needs_requester_info,
        reject,
        rejection_reason,
        expected_date,
        direct_approval_requested,
        direct_approval_approver,
        items,
      } = req.body ?? {}

      if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
        return res.status(404).json({ message: "Purchase request not found" })
      }

      const buyerValidationToken = getBuyerValidationTokenFromRequest(req)

      await client.query("BEGIN")
      transactionStarted = true

      const isBuyerValidationTokenValid = await validateBuyerValidationToken(
        client,
        purchaseRequestId,
        buyerValidationToken
      )

      if (!isBuyerValidationTokenValid || !buyerValidationToken) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(403).json({
          message: "Invalid or expired buyer validation token",
        })
      }

      const currentRequestResult = await client.query(
        `
        SELECT *
        FROM portal.purchase_requests
        WHERE id = $1
        `,
        [purchaseRequestId]
      )

      if (currentRequestResult.rows.length === 0) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(404).json({ message: "Purchase request not found" })
      }

      const currentRequest = currentRequestResult.rows[0]

      if (currentRequest.status !== "pending_buyer_validation") {
        await client.query("ROLLBACK")
        transactionStarted = false

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

      if (
        cleanDirectApprovalApprover &&
        !["Michelle", "Ricardo"].includes(cleanDirectApprovalApprover)
      ) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(400).json({
          message: "Approbateur direct invalide",
        })
      }

      let newStatus = cleanDirectApprovalRequested
        ? "ready_to_purchase"
        : "pending_admin_approval"

      if (needs_requester_info) {
        newStatus = "needs_requester_info"
      }

      if (reject) {
        newStatus = "rejected"
      }

      const cleanExpectedDate =
        typeof expected_date === "string" && expected_date.trim()
          ? expected_date.trim()
          : null

      const cleanNeededByDate = currentRequest.needed_by_date
        ? new Date(currentRequest.needed_by_date).toISOString().slice(0, 10)
        : null

      const finalExpectedDate = cleanExpectedDate || cleanNeededByDate

      const dateChanged =
        finalExpectedDate !== null &&
        cleanNeededByDate !== null &&
        finalExpectedDate !== cleanNeededByDate

      const cleanItems = Array.isArray(items) ? items : []

      if (!needs_requester_info && !reject && cleanItems.length === 0) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(400).json({
          message: "Au moins un article doit être validé",
        })
      }

      for (const item of cleanItems) {
        const itemId = Number(item.id ?? item.item_id)

        const cleanConfirmedUnitPrice =
          item.buyer_confirmed_unit_price === "" ||
          item.buyer_confirmed_unit_price === undefined ||
          item.buyer_confirmed_unit_price === null
            ? null
            : Number(item.buyer_confirmed_unit_price)

        const cleanConfirmedSupplier =
          typeof item.buyer_confirmed_supplier === "string" &&
          item.buyer_confirmed_supplier.trim()
            ? item.buyer_confirmed_supplier.trim()
            : null

        if (!Number.isInteger(itemId) || itemId <= 0) {
          await client.query("ROLLBACK")
          transactionStarted = false

          return res.status(400).json({
            message: "Article invalide",
          })
        }

        if (
          cleanConfirmedUnitPrice !== null &&
          (!Number.isFinite(cleanConfirmedUnitPrice) ||
            cleanConfirmedUnitPrice < 0)
        ) {
          await client.query("ROLLBACK")
          transactionStarted = false

          return res.status(400).json({
            message: "Prix confirmé invalide",
          })
        }

        const updateItemResult = await client.query(
          `
          UPDATE portal.purchase_request_items
          SET
            buyer_confirmed_unit_price = $1,
            buyer_confirmed_supplier = $2,
            status = $3,
            updated_at = now()
          WHERE id = $4
            AND purchase_request_id = $5
          RETURNING *
          `,
          [
            cleanConfirmedUnitPrice,
            cleanConfirmedSupplier,
            newStatus,
            itemId,
            purchaseRequestId,
          ]
        )

        if (updateItemResult.rows.length === 0) {
          await client.query("ROLLBACK")
          transactionStarted = false

          return res.status(400).json({
            message: "Un article est introuvable pour cette demande",
          })
        }
      }

      const updateRequestResult = await client.query(
        `
        UPDATE portal.purchase_requests
        SET
          buyer_user_id = $1,
          buyer_note = $2,
          buyer_validated_at = now(),
          status = $3,
          rejection_reason = $4,
          expected_date = $5,
          date_changed = $6,
          direct_approval_requested = $7,
          direct_approval_approver = $8,
          direct_approval_requested_at = CASE WHEN $7 THEN now() ELSE NULL END,
          updated_at = now()
        WHERE id = $9
        RETURNING *
        `,
        [
          buyer_user_id || null,
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

      const updatedRequestHeader = updateRequestResult.rows[0]

      const adminApprovalToken =
        updatedRequestHeader.status === "pending_admin_approval"
          ? await createAdminApprovalToken(client, updatedRequestHeader.id)
          : null

      const purchaseToken =
        updatedRequestHeader.status === "ready_to_purchase"
          ? await createPurchaseToken(client, updatedRequestHeader.id)
          : null

      await markBuyerValidationTokenUsed(
        client,
        purchaseRequestId,
        buyerValidationToken
      )

      const updatedRequest = await getPurchaseRequestWithItems(
        client,
        purchaseRequestId
      )

      if (!updatedRequest) {
        await client.query("ROLLBACK")
        transactionStarted = false

        return res.status(404).json({ message: "Purchase request not found" })
      }

      await client.query("COMMIT")
      transactionStarted = false

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
          `Ricardo - APPROBATION DIRECTE - demande d'achat #${displayRequestNumber}, achat à faire`,
          buildDirectApprovalBuyerDecisionEmail(updatedRequest, finalRequestUrl),
          buildDirectApprovalBuyerDecisionEmailHtml(updatedRequest, finalRequestUrl)
        )
      }

      const requesterEmail =
        typeof updatedRequest.requester_email === "string"
          ? updatedRequest.requester_email.trim()
          : ""

      if (updatedRequest.date_changed && requesterEmail) {
        const displayRequestNumber = getPurchaseRequestDisplayNumber(updatedRequest)

        await sendPurchaseRequestEmailSafely(
          requesterEmail,
          `Mise à jour de la date pour votre demande d'achat #${displayRequestNumber}`,
          buildRequesterDateChangedEmail(updatedRequest),
          buildRequesterDateChangedEmailHtml(updatedRequest),
          getPurchaseRequestReplyToRecipients()
        )
      }

      return res.json(updatedRequest)
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK")
      }

      console.error("Error validating purchase request:", error)

      return res.status(500).json({
        message: "Error validating purchase request",
      })
    } finally {
      client.release()
    }
  }
)


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

      let updatedRequest = result.rows[0]

      const purchaseToken =
        updatedRequest.status === "ready_to_purchase"
          ? await createPurchaseToken(client, updatedRequest.id)
          : null

      await markAdminApprovalTokenUsed(
        client,
        purchaseRequestId,
        adminApprovalToken,
      )

      const updatedRequestWithItems = await getPurchaseRequestWithItems(
        client,
        purchaseRequestId,
      )

      if (!updatedRequestWithItems) {
        await client.query("ROLLBACK")

        return res.status(404).json({ message: "Purchase request not found" })
      }

      updatedRequest = updatedRequestWithItems

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
        typeof updatedRequest.requester_email === "string"
          ? updatedRequest.requester_email.trim()
          : ""

      if (requesterEmail && (decision === "approved" || decision === "rejected")) {
        await sendPurchaseRequestEmailSafely(
          requesterEmail,
          decision === "approved"
            ? `Votre demande d'achat #${displayRequestNumber} a ete approuvee`
            : `Votre demande d'achat #${displayRequestNumber} a ete refusee`,
          buildRequesterDecisionEmail(updatedRequest),
          buildRequesterDecisionEmailHtml(updatedRequest),
          getPurchaseRequestReplyToRecipients(),
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
  const client = await pool.connect()

  try {
    const { id } = req.params
    const { rejection_reason } = req.body
    const cancellationReason =
      typeof rejection_reason === "string" ? rejection_reason.trim() : null

    await client.query("BEGIN")

    const result = await client.query(
      `
      UPDATE portal.purchase_requests
      SET
        status = 'cancelled',
        rejection_reason = $1,
        cancellation_reason = COALESCE($1, cancellation_reason),
        cancelled_at = now(),
        updated_at = now()
      WHERE id = $2
      RETURNING *
      `,
      [cancellationReason || null, id]
    )

    if (result.rows.length === 0) {
      await client.query("ROLLBACK")

      return res.status(404).json({ message: "Purchase request not found" })
    }

    const cancelledRequest = await getPurchaseRequestWithItems(
      client,
      Number(id),
    )

    if (!cancelledRequest) {
      await client.query("ROLLBACK")

      return res.status(404).json({ message: "Purchase request not found" })
    }

    await client.query("COMMIT")

    const displayRequestNumber = getPurchaseRequestDisplayNumber(cancelledRequest)
    const emailRecipients = getPurchaseRequestRecipients(cancelledRequest)

    await sendPurchaseRequestEmailSafely(
      emailRecipients,
      `Demande d'achat #${displayRequestNumber} annulée`,
      buildPurchaseRequestCancelledEmail(cancelledRequest),
      buildPurchaseRequestCancelledEmailHtml(cancelledRequest),
      getPurchaseRequestReplyToRecipients(),
    )

    res.json(cancelledRequest)
  } catch (error) {
    await client.query("ROLLBACK")

    console.error("Error cancelling purchase request:", error)
    res.status(500).json({ message: "Error cancelling purchase request" })
  } finally {
    client.release()
  }
})






export default router
