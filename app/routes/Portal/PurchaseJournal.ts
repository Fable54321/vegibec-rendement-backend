import { Router } from "express"
import type { Request } from "express"
import type { PoolClient } from "pg"
import { pool } from "../../db"
import {
  getPurchaseRequestStatusLabel,
  createBuyerValidationToken,
  getOrCreateActiveAdminApprovalToken,
  getOrCreateActivePurchaseToken,
  getOrCreateActiveReceiptVoucherToken,
  buildBuyerValidationUrl,
  buildAdminApprovalUrl,
  buildFinalPurchaseRequestUrl,
  buildReceiptVoucherUrl,
} from "./Utils/PurchaseHelper"
import { getSignedUrlForKey } from "../../services/s3.services"

const router = Router()

let recurringColumnsReady: Promise<void> | null = null
function ensureRecurringColumns() {
  recurringColumnsReady ??= pool.query(`
    ALTER TABLE portal.purchase_requests
      ADD COLUMN IF NOT EXISTS is_recurring boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS recurring_source_request_id bigint NULL
        REFERENCES portal.purchase_requests(id) ON DELETE SET NULL
  `).then(() => undefined)
  return recurringColumnsReady
}

function cleanRecurringText(value: unknown) {
  if (typeof value !== "string") return null
  const cleaned = value.trim()
  return cleaned || null
}

function cleanRecurringNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

type PurchaseRequestStatus =
  | "pending_buyer_validation"
  | "needs_requester_info"
  | "pending_admin_approval"
  | "admin_on_wait"
  | "rejected"
  | "ready_to_purchase"
  | "partially_purchased"
  | "purchased"
  | "partially_received"
  | "received"
  | "cancelled"



function getAvailableAction(
  status: PurchaseRequestStatus,
  id: number,
) {
  switch (status) {
    case "pending_buyer_validation":
      return {
        label: "Valider infos d'achat",
        href: `/purchase-journal/${id}/action-link`,
        kind: "buyer_validation",
        disabled: false,
      }

    case "needs_requester_info":
      return {
        label: "Voir les informations demandées",
        href: `/purchase-journal/${id}/action-link`,
        kind: "requester_info",
        disabled: false,
      }

    case "pending_admin_approval":
      return {
        label: "Approuver ou refuser",
        href: `/purchase-journal/${id}/action-link`,
        kind: "admin_decision",
        disabled: false,
      }

    case "admin_on_wait":
      return {
        label: "Mise en attente",
        href: `/purchase-journal/${id}/action-link`,
        kind: "admin_on_wait",
        disabled: true,
      }

   case "ready_to_purchase":
  return {
    label: "Acheter",
    href: `/purchase-journal/${id}/action-link`,
    kind: "purchase",
    disabled: false,
  }

  case "partially_purchased":
  return {
    label: "Continuer l'achat",
    href: `/purchase-journal/${id}/action-link`,
    kind: "purchase",
    disabled: false,
  }

    case "purchased":
    case "partially_received":
      return {
        label: "Remplir un bon de réception",
        href: `/purchase-journal/${id}/action-link`,
        kind: "receipt_voucher",
        disabled: false,
      }

    case "received":
      return {
        label: "Voir les bons de réception",
        href: `/purchase-journal/${id}`,
        kind: "view_receipt_vouchers",
        disabled: false,
      }

    case "rejected":
      return {
        label: "Voir le refus",
        href: `/purchase-journal/${id}`,
        kind: "rejected",
        disabled: false,
      }

    case "cancelled":
  return {
    label: "Voir la raison",
    href: `/purchase-journal/${id}`,
    kind: "view_cancellation_reason",
    disabled: false,
  }

    default:
      return {
        label: "Voir",
        href: `/purchase-journal/${id}`,
        kind: "view",
        disabled: false,
      }
  }
}

function buildPurchaseOrderPdfUrl(purchaseOrderId: number, language: "fr" | "en" = "fr") {
  return `/buying/purchase-orders/${purchaseOrderId}/pdf?lang=${language}`
}

function buildPurchaseOrderPdfDownloadUrl(purchaseOrderId: number, language: "fr" | "en" = "fr") {
  return `/buying/purchase-orders/${purchaseOrderId}/pdf?lang=${language}&download=1`
}

function buildReceiptVoucherPdfUrl(receiptVoucherId: number) {
  return `/receipt-vouchers/${receiptVoucherId}/pdf`
}

function buildReceiptVoucherPdfDownloadUrl(receiptVoucherId: number) {
  return `/receipt-vouchers/${receiptVoucherId}/pdf?download=1`
}

function createPurchaseOrderPdfFilename(reference: string, language: "fr" | "en" = "fr") {
  const safeReference = reference.replace(/[^a-zA-Z0-9_-]/g, "-")

  return `${language === "en" ? "purchase-order" : "bon-commande"}-${safeReference}.pdf`
}

function createPdfDownloadDisposition(filename: string) {
  return `attachment; filename="${filename}"`
}

function createPdfPreviewDisposition(filename: string) {
  return `inline; filename="${filename}"`
}

type PurchaseOrderPdfLink = {
  key: string | null
  language: "fr" | "en"
  preview_url: string
  download_url: string
}

type ReceiptVoucherPdfLink = {
  key: string | null
  preview_url: string
  download_url: string
}

function getPurchaseOrderPdfKeys(value: unknown) {
  if (!value) return []

  if (Array.isArray(value)) {
    return value.filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    )
  }

  if (typeof value === "string") {
    return value ? [value] : []
  }

  return []
}

function getReceiptVoucherPdfKeys(value: unknown) {
  if (!value) return []

  if (Array.isArray(value)) {
    return value.filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    )
  }

  if (typeof value === "string") {
    return value ? [value] : []
  }

  return []
}

async function getPurchaseOrderPdfLinks(po: {
  id: number
  purchase_order_reference: string
  purchase_document_keys?: unknown
}): Promise<PurchaseOrderPdfLink[]> {
  // Use the generation endpoint so saved order data and the current template
  // are always reflected, including fields added after an S3 PDF was created.
  return (["fr", "en"] as const).map((language) => ({
    key: null,
    language,
    preview_url: buildPurchaseOrderPdfUrl(po.id, language),
    download_url: buildPurchaseOrderPdfDownloadUrl(po.id, language),
  }))

}

async function getReceiptVoucherPdfLinks(receiptVoucher: {
  id: number
  receipt_voucher_reference: string
  receipt_document_keys?: unknown
}): Promise<ReceiptVoucherPdfLink[]> {
  // Regenerate from current voucher data instead of serving a stale stored PDF.
  const keys: string[] = []

  if (keys.length === 0) {
    return [
      {
        key: null,
        preview_url: buildReceiptVoucherPdfUrl(receiptVoucher.id),
        download_url: buildReceiptVoucherPdfDownloadUrl(receiptVoucher.id),
      },
    ]
  }

  const safeReference = receiptVoucher.receipt_voucher_reference.replace(
    /[^a-zA-Z0-9_-]/g,
    "-",
  )
  const filename = `bon-reception-${safeReference}.pdf`

  return Promise.all(
    keys.map(async (key) => ({
      key,
      preview_url: await getSignedUrlForKey(key, {
        expiresIn: 60 * 60,
        responseContentDisposition: createPdfPreviewDisposition(filename),
        responseContentType: "application/pdf",
      }),
      download_url: await getSignedUrlForKey(key, {
        expiresIn: 60 * 60,
        responseContentDisposition: createPdfDownloadDisposition(filename),
        responseContentType: "application/pdf",
      }),
    })),
  )
}

async function buildCurrentActionLink(
  client: PoolClient,
  req: Request,
  purchaseRequestId: number,
  status: PurchaseRequestStatus,
) {
  switch (status) {
    case "pending_buyer_validation": {
      const token = await createBuyerValidationToken(client, purchaseRequestId)

      return buildBuyerValidationUrl(req, purchaseRequestId, token)
    }

    case "pending_admin_approval": {
      const token = await getOrCreateActiveAdminApprovalToken(
        client,
        purchaseRequestId,
      )

      return buildAdminApprovalUrl(req, purchaseRequestId, token)
    }

    case "ready_to_purchase":
    case "partially_purchased": {
      const token = await getOrCreateActivePurchaseToken(
        client,
        purchaseRequestId,
      )

      return buildFinalPurchaseRequestUrl(req, purchaseRequestId, token)
    }

    case "purchased":
    case "partially_received": {
      const token = await getOrCreateActiveReceiptVoucherToken(
        client,
        purchaseRequestId,
      )

      return buildReceiptVoucherUrl(req, purchaseRequestId, token)
    }

    default:
      return buildFinalPurchaseRequestUrl(req, purchaseRequestId)
  }
}

function cleanEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function isValidDateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function getDelegationSelectSql(whereClause: string) {
  return `
    SELECT
      ped.id,
      ped.buyer_user_id,
      ped.delegate_user_id,
      ped.delegate_email,
      ped.starts_at,
      ped.ends_at,
      ped.send_copy_to_buyer,
      ped.is_active,
      ped.created_at,
      ped.updated_at,
      to_char(ped.starts_at AT TIME ZONE 'America/Toronto', 'YYYY-MM-DD') AS starts_on,
      to_char(ped.ends_at AT TIME ZONE 'America/Toronto', 'YYYY-MM-DD') AS ends_on,
      delegate_user.name AS delegate_name,
      delegate_user.surname AS delegate_surname
    FROM portal.purchase_email_delegations ped
    LEFT JOIN public.users delegate_user
      ON delegate_user.id = ped.delegate_user_id
    ${whereClause}
  `
}

router.get("/", async (req, res) => {
  try {
    await ensureRecurringColumns()
    const { status } = req.query

    const params: unknown[] = []
    let whereClause = ""

    if (typeof status === "string" && status.trim()) {
      params.push(status.trim())
      whereClause = `WHERE pr.status = $1`
    }

    const result = await pool.query(
      `
      SELECT
        pr.id,
        pr.request_reference,
        pr.requested_by,
        pr.requester_email,
        pr.is_recurring,
        pr.recurring_source_request_id,
        pr.status,
        pr.urgency,
        pr.needed_by_date,
        pr.expected_date,
        pr.requested_at,
        pr.created_at,
        pr.buyer_validated_at,
pr.admin_decision_at,
pr.cancelled_at,
pr.cancelled_by_name,
pr.cancelled_by_email,
pr.cancellation_reason,
pr.updated_at,

        COALESCE(items.item_count, 0)::int AS item_count,

        COALESCE(items.item_descriptions, ARRAY[]::text[]) AS item_descriptions,
        COALESCE(items.items, '[]'::json) AS items,

        COALESCE(items.requested_total_quantity, 0)::numeric
          AS requested_total_quantity,

        COALESCE(items.requested_total_price, 0)::numeric
          AS requested_total_price,

        COALESCE(items.buyer_confirmed_total_price, 0)::numeric
          AS buyer_confirmed_total_price,

        COALESCE(orders.purchase_order_count, 0)::int
          AS purchase_order_count,

        COALESCE(receipts.receipt_voucher_count, 0)::int
          AS receipt_voucher_count,

        COALESCE(orders.ordered_total_quantity, 0)::numeric
          AS ordered_total_quantity,

        COALESCE(orders.purchased_total_quantity, 0)::numeric
          AS purchased_total_quantity,

        COALESCE(receipts.received_total_quantity, 0)::numeric
          AS received_total_quantity,

        COALESCE(orders.actual_purchased_total_price, 0)::numeric
          AS purchase_orders_total,

        COALESCE(orders.actual_purchased_total_price, 0)::numeric
          AS actual_purchased_total_price,

        orders.last_purchased_at,
        receipts.last_received_at,

        first_item.description AS description

      FROM portal.purchase_requests pr

      LEFT JOIN (
        SELECT
          purchase_request_id,
          COUNT(*)::int AS item_count,

          ARRAY_AGG(description ORDER BY item_index ASC, id ASC)
            AS item_descriptions,

          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', id,
              'description', description,
              'quantity', quantity,
              'quantity_format', quantity_format
            )
            ORDER BY item_index ASC, id ASC
          ) AS items,

          COALESCE(
            SUM(requested_total_price),
            0
          )::numeric AS requested_total_price,

          COALESCE(
            SUM(buyer_confirmed_total_price),
            0
          )::numeric AS buyer_confirmed_total_price,

          COALESCE(SUM(quantity), 0)::numeric AS requested_total_quantity

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

      LEFT JOIN (
        SELECT
          po.purchase_request_id,

          COUNT(DISTINCT po.id)::int AS purchase_order_count,

          COALESCE(
            SUM(
              COALESCE(
                poi.final_total_price,
                poi.ordered_quantity * poi.final_unit_price
              )
            ),
            0
          )::numeric AS actual_purchased_total_price,

          COALESCE(SUM(poi.ordered_quantity), 0)::numeric
            AS ordered_total_quantity,

          COALESCE(SUM(poi.ordered_quantity), 0)::numeric
            AS purchased_total_quantity,

          MAX(po.purchased_at) AS last_purchased_at,
          MAX(po.received_at) AS last_received_at

        FROM portal.purchase_orders po

        LEFT JOIN portal.purchase_order_items poi
          ON poi.purchase_order_id = po.id

        GROUP BY po.purchase_request_id
      ) orders
        ON orders.purchase_request_id = pr.id

      LEFT JOIN (
        SELECT
          rv.purchase_request_id,
          COUNT(DISTINCT rv.id)::int AS receipt_voucher_count,
          COALESCE(SUM(rvi.received_quantity), 0)::numeric
            AS received_total_quantity,
          MAX(rv.received_at) AS last_received_at
        FROM portal.receipt_vouchers rv
        LEFT JOIN portal.receipt_voucher_items rvi
          ON rvi.receipt_voucher_id = rv.id
        GROUP BY rv.purchase_request_id
      ) receipts
        ON receipts.purchase_request_id = pr.id

      ${whereClause}

      ORDER BY pr.created_at DESC
      `,
      params,
    )

    const rows = result.rows.map((row) => {
      const purchaseOrderCount = Number(row.purchase_order_count || 0)
      const buyerConfirmedTotal = Number(row.buyer_confirmed_total_price || 0)
      const requestedTotal = Number(row.requested_total_price || 0)
      const actualPurchasedTotal = Number(row.actual_purchased_total_price || 0)
      const requestedTotalQuantity = Number(row.requested_total_quantity || 0)
      const purchasedTotalQuantity = Number(row.purchased_total_quantity || 0)
      const orderedTotalQuantity = Number(row.ordered_total_quantity || 0)
      const receivedTotalQuantity = Number(row.received_total_quantity || 0)

      const hasPurchaseOrders = purchaseOrderCount > 0
      const hasBuyerConfirmedPrice = buyerConfirmedTotal > 0

      const displayTotalPrice = hasPurchaseOrders
        ? row.actual_purchased_total_price
        : hasBuyerConfirmedPrice
          ? row.buyer_confirmed_total_price
          : row.requested_total_price

      const displayTotalPriceSource = hasPurchaseOrders
        ? "actual_purchased"
        : hasBuyerConfirmedPrice
          ? "buyer_confirmed"
          : "requester_estimated"

      return {
        ...row,

        id: Number(row.id),

        item_count: Number(row.item_count || 0),
        item_descriptions: Array.isArray(row.item_descriptions)
          ? row.item_descriptions.filter(Boolean)
          : [],
        items: Array.isArray(row.items) ? row.items : [],
        purchase_order_count: purchaseOrderCount,
        receipt_voucher_count: Number(row.receipt_voucher_count || 0),
        requested_total_quantity: requestedTotalQuantity,
        purchased_total_quantity: purchasedTotalQuantity,
        ordered_total_quantity: orderedTotalQuantity,
        received_total_quantity: receivedTotalQuantity,
        has_receivable_items:
          orderedTotalQuantity > 0 && receivedTotalQuantity < orderedTotalQuantity,

        requested_total_price: requestedTotal,
        buyer_confirmed_total_price: buyerConfirmedTotal,
        actual_purchased_total_price: actualPurchasedTotal,
        purchase_orders_total: actualPurchasedTotal,

        display_total_price: displayTotalPrice,
        display_total_price_source: displayTotalPriceSource,

        // Compatibility aliases for the frontend context
        admin_decided_at: row.admin_decision_at,
        purchased_at: row.last_purchased_at,
        received_at: row.last_received_at,
        cancelled_at: row.cancelled_at,
cancelled_by_name: row.cancelled_by_name,
cancelled_by_email: row.cancelled_by_email,
cancellation_reason: row.cancellation_reason,
        status_label: getPurchaseRequestStatusLabel(row.status),

        available_action: getAvailableAction(row.status, Number(row.id)),
      }
    })

    return res.json(rows)
  } catch (error) {
    console.error("Purchase journal list error:", error)

    return res.status(500).json({
      message: "Unable to load purchase journal",
    })
  }
})

router.patch("/:id/recurring", async (req, res) => {
  try {
    await ensureRecurringColumns()
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid purchase request id" })
    const result = await pool.query(`UPDATE portal.purchase_requests SET is_recurring = $2, updated_at = now() WHERE id = $1 RETURNING id, is_recurring`, [id, Boolean(req.body?.is_recurring)])
    if (!result.rows[0]) return res.status(404).json({ message: "Purchase request not found" })
    return res.json(result.rows[0])
  } catch (error) {
    console.error("Recurring purchase request update error:", error)
    return res.status(500).json({ message: "Unable to update recurring purchase request" })
  }
})

router.post("/:id/create-recurrence", async (req, res) => {
  const client = await pool.connect()
  let transactionStarted = false
  try {
    await ensureRecurringColumns()
    const sourceRequestId = Number(req.params.id)
    const sourceOrderId = Number(req.body?.source_purchase_order_id)
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (!Number.isInteger(sourceRequestId) || sourceRequestId <= 0 || !Number.isInteger(sourceOrderId) || sourceOrderId <= 0 || items.length === 0) {
      return res.status(400).json({ message: "A source order and at least one item are required" })
    }
    await client.query("BEGIN"); transactionStarted = true
    await client.query("SELECT pg_advisory_xact_lock(hashtext('portal.purchase_requests.reference'))")
    const source = await client.query(`SELECT * FROM portal.purchase_requests WHERE id = $1 AND is_recurring = true FOR UPDATE`, [sourceRequestId])
    if (!source.rows[0]) { await client.query("ROLLBACK"); transactionStarted = false; return res.status(404).json({ message: "Recurring purchase request not found" }) }
    const sourceOrder = await client.query(`SELECT * FROM portal.purchase_orders WHERE id = $1 AND purchase_request_id = $2`, [sourceOrderId, sourceRequestId])
    if (!sourceOrder.rows[0]) { await client.query("ROLLBACK"); transactionStarted = false; return res.status(404).json({ message: "Source purchase order not found" }) }

    const next = await client.query(`SELECT portal.next_purchase_request_reference() AS reference`)
    const reference = String(next.rows[0].reference)
    const referenceParts = reference.match(/^req-(\d{2})-(\d{1,2})-(\d{2,})$/)
    if (!referenceParts) throw new Error("Invalid generated purchase request reference")
    const year = 2000 + Number(referenceParts[1]); const month = Number(referenceParts[2]); const sequence = Number(referenceParts[3])
    const requestResult = await client.query(`INSERT INTO portal.purchase_requests (request_reference, request_year, request_month, request_month_sequence, requested_by, requester_email, urgency, needed_by_date, expected_date, status, is_recurring, recurring_source_request_id, buyer_user_id, buyer_validated_at, buyer_note, buyer_email, admin_user_id, admin_decision, admin_decision_at, admin_note, admin_email, purchased_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'purchased',true,$10,$11,now(),$12,$13,$14,'approved',now(),$15,$16,now()) RETURNING *`, [reference, year, month, sequence, source.rows[0].requested_by, source.rows[0].requester_email, source.rows[0].urgency, req.body?.needed_by_date || source.rows[0].needed_by_date, req.body?.requested_delivery_date || source.rows[0].expected_date, sourceRequestId, req.user?.id ?? source.rows[0].buyer_user_id, source.rows[0].buyer_note, req.body?.buyer_email || source.rows[0].buyer_email, source.rows[0].admin_user_id, source.rows[0].admin_note, source.rows[0].admin_email])
    const newRequest = requestResult.rows[0]
    const requestItemIds: number[] = []
    for (let index = 0; index < items.length; index++) {
      const item = items[index]; const quantity = cleanRecurringNumber(item.quantity)
      if (!cleanRecurringText(item.item_description) || quantity === null || quantity <= 0) throw new Error("Invalid recurring item")
      const inserted = await client.query(`INSERT INTO portal.purchase_request_items (purchase_request_id,item_index,description,quantity,quantity_format,requested_unit_price,requested_total_price,buyer_confirmed_unit_price,buyer_confirmed_total_price,buyer_confirmed_supplier,status) VALUES ($1,$2,$3,$4,$5,$6,$4*$6,$6,$4*$6,$7,'purchased') RETURNING id`, [newRequest.id,index,cleanRecurringText(item.item_description),quantity,cleanRecurringText(item.ordered_unit),cleanRecurringNumber(item.ordered_unit_price),cleanRecurringText(req.body?.supplier_name)])
      requestItemIds.push(Number(inserted.rows[0].id))
    }
    const orderReference = `bc-${referenceParts[1]}-${referenceParts[2]}-${referenceParts[3]}`
    const orderResult = await client.query(`INSERT INTO portal.purchase_orders (purchase_request_id,purchase_order_reference,purchase_order_sequence,supplier_id,supplier,supplier_name,supplier_address_snapshot,supplier_phone,purchased_by_user_id,purchased_at,supplier_reference,purchase_note,buyer_name,buyer_email,buyer_phone,requested_delivery_date,delivery_method,shipping_address_snapshot,currency_code,status) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,COALESCE($9::timestamptz,now()),$10,$11,$12,$13,$14,$15,$16,$17,$18,'ordered') RETURNING *`, [newRequest.id,orderReference,sequence,req.body?.supplier_id || null,cleanRecurringText(req.body?.supplier_name),cleanRecurringText(req.body?.supplier_address_snapshot),cleanRecurringText(req.body?.supplier_phone),req.user?.id ?? null,req.body?.ordered_at,cleanRecurringText(req.body?.supplier_reference),cleanRecurringText(req.body?.purchase_note),cleanRecurringText(req.body?.buyer_name),cleanRecurringText(req.body?.buyer_email),cleanRecurringText(req.body?.buyer_phone),req.body?.requested_delivery_date || null,cleanRecurringText(req.body?.delivery_method),cleanRecurringText(req.body?.shipping_address_snapshot),cleanRecurringText(req.body?.currency_code) || "CAD"])
    for (let index = 0; index < items.length; index++) { const item = items[index]; await client.query(`INSERT INTO portal.purchase_order_items (purchase_order_id,purchase_request_item_id,ordered_quantity,final_unit_price,item_code,item_description,ordered_unit,location) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [orderResult.rows[0].id,requestItemIds[index],cleanRecurringNumber(item.quantity),cleanRecurringNumber(item.ordered_unit_price),cleanRecurringText(item.item_code),cleanRecurringText(item.item_description),cleanRecurringText(item.ordered_unit),cleanRecurringText(item.location)]) }
    await client.query("COMMIT"); transactionStarted = false
    return res.status(201).json({ purchase_request: newRequest, purchase_order: orderResult.rows[0] })
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK")
    console.error("Recurring purchase order creation error:", error)
    return res.status(500).json({ message: "Unable to create recurring purchase order" })
  } finally { client.release() }
})

router.get("/email-delegation", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" })
    }

    const result = await pool.query(
      `
      ${getDelegationSelectSql(`
      WHERE ped.buyer_user_id = $1
        AND ped.is_active = true
        AND ped.ends_at >= now()
      `)}
      ORDER BY ped.starts_at DESC, ped.id DESC
      LIMIT 1
      `,
      [req.user.id],
    )

    return res.json({
      delegation: result.rows[0] ?? null,
    })
  } catch (error) {
    console.error("Purchase email delegation load error:", error)

    return res.status(500).json({
      message: "Unable to load purchase email delegation",
    })
  }
})

router.post("/email-delegation", async (req, res) => {
  const client = await pool.connect()

  try {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" })
    }

    const delegateEmail = cleanEmail(req.body?.delegate_email)
    const startsOn = req.body?.starts_on
    const endsOn = req.body?.ends_on
    const sendCopyToBuyer = Boolean(req.body?.send_copy_to_buyer)

    if (!isValidEmail(delegateEmail)) {
      return res.status(400).json({
        message: "Delegate email is invalid",
      })
    }

    if (!isValidDateOnly(startsOn) || !isValidDateOnly(endsOn)) {
      return res.status(400).json({
        message: "Start and end dates are required",
      })
    }

    if (startsOn > endsOn) {
      return res.status(400).json({
        message: "End date must be on or after start date",
      })
    }

    await client.query("BEGIN")

    const delegateUserResult = await client.query(
      `
      SELECT id
      FROM public.users
      WHERE LOWER(email) = $1
      LIMIT 1
      `,
      [delegateEmail],
    )

    const delegateUserId = delegateUserResult.rows[0]?.id ?? null

    await client.query(
      `
      UPDATE portal.purchase_email_delegations
      SET
        is_active = false,
        updated_at = now()
      WHERE buyer_user_id = $1
        AND is_active = true
        AND ends_at >= now()
      `,
      [req.user.id],
    )

    const insertResult = await client.query(
      `
      INSERT INTO portal.purchase_email_delegations (
        buyer_user_id,
        delegate_user_id,
        delegate_email,
        starts_at,
        ends_at,
        send_copy_to_buyer,
        is_active
      )
      VALUES (
        $1,
        $2,
        $3,
        ($4::date::timestamp AT TIME ZONE 'America/Toronto'),
        ((($5::date + 1)::timestamp AT TIME ZONE 'America/Toronto') - interval '1 millisecond'),
        $6,
        true
      )
      RETURNING id
      `,
      [
        req.user.id,
        delegateUserId,
        delegateEmail,
        startsOn,
        endsOn,
        sendCopyToBuyer,
      ],
    )

    const delegationResult = await client.query(
      `
      ${getDelegationSelectSql("WHERE ped.id = $1")}
      `,
      [insertResult.rows[0].id],
    )

    await client.query("COMMIT")

    return res.status(201).json({
      delegation: delegationResult.rows[0],
    })
  } catch (error) {
    await client.query("ROLLBACK")

    console.error("Purchase email delegation save error:", error)

    return res.status(500).json({
      message: "Unable to save purchase email delegation",
    })
  } finally {
    client.release()
  }
})

router.delete("/email-delegation/:id", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" })
    }

    const delegationId = Number(req.params.id)

    if (!Number.isInteger(delegationId) || delegationId <= 0) {
      return res.status(404).json({
        message: "Purchase email delegation not found",
      })
    }

    const result = await pool.query(
      `
      UPDATE portal.purchase_email_delegations
      SET
        is_active = false,
        updated_at = now()
      WHERE id = $1
        AND buyer_user_id = $2
      RETURNING id
      `,
      [delegationId, req.user.id],
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Purchase email delegation not found",
      })
    }

    return res.json({ message: "Purchase email delegation disabled" })
  } catch (error) {
    console.error("Purchase email delegation disable error:", error)

    return res.status(500).json({
      message: "Unable to disable purchase email delegation",
    })
  }
})


router.post("/:id/action-link", async (req, res) => {
  const client = await pool.connect()

  try {
    const purchaseRequestId = Number(req.params.id)

    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const requestResult = await client.query(
      `
      SELECT id, status
      FROM portal.purchase_requests
      WHERE id = $1
      `,
      [purchaseRequestId],
    )

    if (requestResult.rows.length === 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const request = requestResult.rows[0]
    const action = getAvailableAction(request.status, purchaseRequestId)

    if (
      action.disabled ||
      action.kind === "view" ||
      action.kind === "view_purchase_orders" ||
      action.kind === "view_receipt_vouchers" ||
      action.kind === "rejected" ||
      action.kind === "cancelled" ||
      action.kind === "view_cancellation_reason"
    ) {
      return res.status(400).json({
        message: "This request has no action link",
      })
    }

    return res.json({
      href: await buildCurrentActionLink(
        client,
        req,
        purchaseRequestId,
        request.status,
      ),
      kind: action.kind,
    })
  } catch (error) {
    console.error("Purchase action link generation error:", error)

    return res.status(500).json({
      message: "Unable to generate purchase action link",
    })
  } finally {
    client.release()
  }
})

router.post("/:id/purchase-link", async (req, res) => {
  const client = await pool.connect()

  try {
    const purchaseRequestId = Number(req.params.id)

    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const requestResult = await client.query(
      `
      SELECT id, status
      FROM portal.purchase_requests
      WHERE id = $1
      `,
      [purchaseRequestId],
    )

    if (requestResult.rows.length === 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const request = requestResult.rows[0]

    if (
      request.status !== "ready_to_purchase" &&
      request.status !== "partially_purchased" &&
      request.status !== "partially_received"
    ) {
      return res.status(400).json({
        message: "This request is not ready to purchase",
      })
    }

    const token = await getOrCreateActivePurchaseToken(
      client,
      purchaseRequestId,
    )

    return res.json({
      href: buildFinalPurchaseRequestUrl(req, purchaseRequestId, token),
      kind: "purchase",
    })
  } catch (error) {
    console.error("Purchase link generation error:", error)

    return res.status(500).json({
      message: "Unable to generate purchase link",
    })
  } finally {
    client.release()
  }
})

router.post("/:id/receipt-voucher-link", async (req, res) => {
  const client = await pool.connect()

  try {
    const purchaseRequestId = Number(req.params.id)

    if (!Number.isInteger(purchaseRequestId) || purchaseRequestId <= 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const requestResult = await client.query(
      `
      SELECT
        pr.id,
        pr.status,
        COALESCE(orders.ordered_total_quantity, 0)::numeric
          AS ordered_total_quantity,
        COALESCE(receipts.received_total_quantity, 0)::numeric
          AS received_total_quantity
      FROM portal.purchase_requests pr
      LEFT JOIN (
        SELECT
          po.purchase_request_id,
          COALESCE(SUM(poi.ordered_quantity), 0)::numeric
            AS ordered_total_quantity
        FROM portal.purchase_orders po
        LEFT JOIN portal.purchase_order_items poi
          ON poi.purchase_order_id = po.id
        GROUP BY po.purchase_request_id
      ) orders
        ON orders.purchase_request_id = pr.id
      LEFT JOIN (
        SELECT
          rv.purchase_request_id,
          COALESCE(SUM(rvi.received_quantity), 0)::numeric
            AS received_total_quantity
        FROM portal.receipt_vouchers rv
        LEFT JOIN portal.receipt_voucher_items rvi
          ON rvi.receipt_voucher_id = rv.id
        GROUP BY rv.purchase_request_id
      ) receipts
        ON receipts.purchase_request_id = pr.id
      WHERE pr.id = $1
      `,
      [purchaseRequestId],
    )

    if (requestResult.rows.length === 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const request = requestResult.rows[0]
    const orderedTotalQuantity = Number(request.ordered_total_quantity || 0)
    const receivedTotalQuantity = Number(request.received_total_quantity || 0)
    const hasReceivableItems =
      orderedTotalQuantity > 0 && receivedTotalQuantity < orderedTotalQuantity

    if (
      !hasReceivableItems ||
      !["partially_purchased", "purchased", "partially_received"].includes(
        request.status,
      )
    ) {
      return res.status(400).json({
        message: "This purchase request is not ready to receive",
      })
    }

    const token = await getOrCreateActiveReceiptVoucherToken(
      client,
      purchaseRequestId,
    )

    return res.json({
      href: buildReceiptVoucherUrl(req, purchaseRequestId, token),
      kind: "receipt_voucher",
    })
  } catch (error) {
    console.error("Receipt voucher link generation error:", error)

    return res.status(500).json({
      message: "Unable to generate receipt voucher link",
    })
  } finally {
    client.release()
  }
})

router.get("/:id", async (req, res) => {
  const client = await pool.connect()

  try {
    const id = Number(req.params.id)

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const requestResult = await client.query(
      `
      SELECT
        pr.*,

        buyer.name AS buyer_name,
        buyer.surname AS buyer_surname,
        buyer.email AS buyer_user_email,

        admin.name AS admin_name,
        admin.surname AS admin_surname,
        admin.email AS admin_user_email,

        purchased_by.name AS purchased_by_name,
        purchased_by.surname AS purchased_by_surname,
        purchased_by.email AS purchased_by_email,

        COALESCE(item_totals.requested_total_price, 0)::numeric AS requested_total_price,
        COALESCE(item_totals.buyer_confirmed_total_price, 0)::numeric AS buyer_confirmed_total_price,
        COALESCE(item_totals.requested_total_quantity, 0)::numeric AS requested_total_quantity,
        COALESCE(purchased_items.purchased_total_quantity, 0)::numeric AS purchased_total_quantity

      FROM portal.purchase_requests pr

      LEFT JOIN public.users buyer
        ON buyer.id = pr.buyer_user_id

      LEFT JOIN public.users admin
        ON admin.id = pr.admin_user_id

      LEFT JOIN portal.purchase_orders latest_po
        ON latest_po.purchase_request_id = pr.id

      LEFT JOIN public.users purchased_by
        ON purchased_by.id = latest_po.purchased_by_user_id

      LEFT JOIN (
        SELECT
          purchase_request_id,
          COALESCE(SUM(requested_total_price), 0)::numeric AS requested_total_price,
          COALESCE(SUM(buyer_confirmed_total_price), 0)::numeric AS buyer_confirmed_total_price,
          COALESCE(SUM(quantity), 0)::numeric AS requested_total_quantity
        FROM portal.purchase_request_items
        GROUP BY purchase_request_id
      ) item_totals
        ON item_totals.purchase_request_id = pr.id

      LEFT JOIN (
        SELECT
          po.purchase_request_id,
          COALESCE(SUM(poi.ordered_quantity), 0)::numeric AS purchased_total_quantity
        FROM portal.purchase_orders po
        LEFT JOIN portal.purchase_order_items poi
          ON poi.purchase_order_id = po.id
        GROUP BY po.purchase_request_id
      ) purchased_items
        ON purchased_items.purchase_request_id = pr.id

      WHERE pr.id = $1

      ORDER BY latest_po.purchased_at DESC NULLS LAST

      LIMIT 1
      `,
      [id],
    )

    if (requestResult.rows.length === 0) {
      return res.status(404).json({
        message: "Purchase request not found",
      })
    }

    const request = requestResult.rows[0]

    const itemsResult = await client.query(
      `
      SELECT
        id,
        purchase_request_id,
        item_index,
        description,
        reason,
        quantity,
        quantity_format,
        requested_unit_price,
        requested_total_price,
        requested_supplier,
        product_link,
        buyer_confirmed_unit_price,
        buyer_confirmed_total_price,
        buyer_confirmed_supplier,
        status,
        created_at,
        updated_at,
        EXISTS (
          SELECT 1
          FROM portal.purchase_order_items poi
          WHERE poi.purchase_request_item_id = pri.id
        ) AS has_purchase_order
      FROM portal.purchase_request_items pri
      WHERE pri.purchase_request_id = $1
      ORDER BY item_index ASC, id ASC
      `,
      [id],
    )

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
        po.buyer_name,
        po.buyer_email,
        po.requested_delivery_date,
        po.received_at,
        po.invoice_number,
        po.delivery_method,
        po.shipping_address_snapshot,
        po.currency_code,
        po.supplier_reference,
        po.purchase_note,
        po.purchase_document_keys,
        po.status,
        po.created_at,
        po.updated_at,
        po.purchased_at,

        po.purchased_at AS ordered_at,

        COALESCE(order_totals.subtotal_price, 0)::numeric AS subtotal_price,
        0::numeric AS taxes_price,
        0::numeric AS shipping_price,
        COALESCE(order_totals.subtotal_price, 0)::numeric AS final_total_price,

        purchased_by.name AS purchased_by_name,
        purchased_by.surname AS purchased_by_surname,
        purchased_by.email AS purchased_by_email

      FROM portal.purchase_orders po

      LEFT JOIN (
        SELECT
          purchase_order_id,
          COALESCE(
            SUM(
              COALESCE(
                final_total_price,
                ordered_quantity * final_unit_price
              )
            ),
            0
          )::numeric AS subtotal_price
        FROM portal.purchase_order_items
        GROUP BY purchase_order_id
      ) order_totals
        ON order_totals.purchase_order_id = po.id

      LEFT JOIN public.users purchased_by
        ON purchased_by.id = po.purchased_by_user_id

      WHERE po.purchase_request_id = $1

      ORDER BY po.purchase_order_sequence ASC, po.purchase_order_subsequence ASC NULLS FIRST, po.id ASC
      `,
      [id],
    )

    const purchaseOrderIds = purchaseOrdersResult.rows.map((po) => po.id)

    let purchaseOrderItems: Record<number, unknown[]> = {}

    if (purchaseOrderIds.length > 0) {
      const purchaseOrderItemsResult = await client.query(
        `
        SELECT
          poi.id,
          poi.purchase_order_id,
          poi.purchase_request_item_id AS item_id,
          poi.item_code,
          poi.item_description,
          poi.ordered_quantity AS quantity,
          poi.ordered_unit,
          poi.final_unit_price AS ordered_unit_price,
          COALESCE(
            poi.final_total_price,
            poi.ordered_quantity * poi.final_unit_price
          )::numeric AS ordered_total_price,
          poi.number_of_pallets,
          poi.location,
          poi.created_at,
          poi.updated_at
        FROM portal.purchase_order_items poi
        WHERE poi.purchase_order_id = ANY($1::int[])
        ORDER BY poi.purchase_order_id ASC, poi.id ASC
        `,
        [purchaseOrderIds],
      )

      purchaseOrderItems = purchaseOrderItemsResult.rows.reduce(
        (acc, item) => {
          if (!acc[item.purchase_order_id]) {
            acc[item.purchase_order_id] = []
          }

          acc[item.purchase_order_id].push(item)

          return acc
        },
        {} as Record<number, unknown[]>,
      )
    }

 const receiptVouchersResult = await client.query(
  `
  SELECT
    rv.id,
    rv.purchase_request_id,
    rv.receipt_voucher_reference,
    rv.receipt_voucher_sequence,
    rv.received_by_name,
    rv.received_by_email,
    rv.received_at,
    rv.receipt_note,
    rv.supplier_name,
    rv.supplier_address_snapshot,
    rv.supplier_phone,
    rv.delivery_method,
    rv.receipt_document_keys,
    rv.status,
    rv.created_at,
    rv.updated_at
  FROM portal.receipt_vouchers rv
  WHERE rv.purchase_request_id = $1
  ORDER BY rv.receipt_voucher_sequence ASC, rv.id ASC
  `,
  [id],
)

    const receiptVoucherIds = receiptVouchersResult.rows.map((rv) => rv.id)
    let receiptVoucherItems: Record<number, unknown[]> = {}
    let receiptVoucherItemsByPurchaseOrder: Record<number, unknown[]> = {}

    if (receiptVoucherIds.length > 0) {
      const receiptVoucherItemsResult = await client.query(
        `
        SELECT
          rvi.id,
          rvi.receipt_voucher_id,
          rvi.purchase_request_item_id,
          rvi.purchase_order_item_id,
          poi.purchase_order_id,
          poi.item_code,
          poi.item_description,
          poi.ordered_unit,
          po.purchase_order_reference,
          rvi.quantity,
          rvi.received_quantity,
          rvi.comment,
          rvi.created_at,
          rvi.updated_at
        FROM portal.receipt_voucher_items rvi
        LEFT JOIN portal.purchase_order_items poi
          ON poi.id = rvi.purchase_order_item_id
        LEFT JOIN portal.purchase_orders po
          ON po.id = poi.purchase_order_id
        WHERE rvi.receipt_voucher_id = ANY($1::int[])
        ORDER BY rvi.receipt_voucher_id ASC, rvi.id ASC
        `,
        [receiptVoucherIds],
      )

      receiptVoucherItems = receiptVoucherItemsResult.rows.reduce(
        (acc, item) => {
          if (!acc[item.receipt_voucher_id]) {
            acc[item.receipt_voucher_id] = []
          }

          acc[item.receipt_voucher_id].push(item)

          return acc
        },
        {} as Record<number, unknown[]>,
      )

      receiptVoucherItemsByPurchaseOrder = receiptVoucherItemsResult.rows.reduce(
        (acc, item) => {
          if (!item.purchase_order_id) return acc

          if (!acc[item.purchase_order_id]) {
            acc[item.purchase_order_id] = []
          }

          acc[item.purchase_order_id].push(item)

          return acc
        },
        {} as Record<number, unknown[]>,
      )
    }

    const receipt_vouchers = await Promise.all(
      receiptVouchersResult.rows.map(async (rv) => {
        const receiptVoucherPdfLinks = await getReceiptVoucherPdfLinks(rv)
        const firstReceiptVoucherPdf = receiptVoucherPdfLinks[0] ?? null

        return {
          ...rv,
          items: receiptVoucherItems[rv.id] ?? [],
          documents: {
            receipt_voucher_pdf_url:
              firstReceiptVoucherPdf?.preview_url ?? null,
            receipt_voucher_pdf_preview_url:
              firstReceiptVoucherPdf?.preview_url ?? null,
            receipt_voucher_pdf_download_url:
              firstReceiptVoucherPdf?.download_url ?? null,
            receipt_voucher_pdf_urls: receiptVoucherPdfLinks.map(
              (link) => link.preview_url,
            ),
            receipt_voucher_pdf_preview_urls: receiptVoucherPdfLinks.map(
              (link) => link.preview_url,
            ),
            receipt_voucher_pdf_download_urls: receiptVoucherPdfLinks.map(
              (link) => link.download_url,
            ),
            receipt_voucher_pdfs: receiptVoucherPdfLinks,
          },
        }
      }),
    )

    const purchase_orders = await Promise.all(
      purchaseOrdersResult.rows.map(async (po) => {
        const purchaseOrderPdfLinks = await getPurchaseOrderPdfLinks(po)
        const firstPurchaseOrderPdf = purchaseOrderPdfLinks[0] ?? null
        const orderReceiptItems =
          receiptVoucherItemsByPurchaseOrder[po.id] ?? []
        const orderReceiptVoucherIds = new Set(
          orderReceiptItems.map((item: any) => item.receipt_voucher_id),
        )
        const orderReceiptVouchers = receipt_vouchers.filter((rv) =>
          orderReceiptVoucherIds.has(rv.id),
        )
        const orderReceiptVoucherPreviewUrls = orderReceiptVouchers.flatMap(
          (rv) => rv.documents.receipt_voucher_pdf_preview_urls,
        )
        const orderReceiptVoucherDownloadUrls = orderReceiptVouchers.flatMap(
          (rv) => rv.documents.receipt_voucher_pdf_download_urls,
        )

        return {
          ...po,
          items: purchaseOrderItems[po.id] ?? [],
          receipt_vouchers: orderReceiptVouchers,
          receipt_voucher_items: orderReceiptItems,
          documents: {
            purchase_order_pdf_url: firstPurchaseOrderPdf?.preview_url ?? null,
            purchase_order_pdf_preview_url:
              firstPurchaseOrderPdf?.preview_url ?? null,
            purchase_order_pdf_download_url:
              firstPurchaseOrderPdf?.download_url ?? null,
            purchase_order_pdf_urls: purchaseOrderPdfLinks.map(
              (link) => link.preview_url,
            ),
            purchase_order_pdf_preview_urls: purchaseOrderPdfLinks.map(
              (link) => link.preview_url,
            ),
            purchase_order_pdf_download_urls: purchaseOrderPdfLinks.map(
              (link) => link.download_url,
            ),
            purchase_order_pdfs: purchaseOrderPdfLinks,
            receipt_voucher_pdf_url: orderReceiptVouchers.length > 0
              ? orderReceiptVoucherPreviewUrls[0] ?? null
              : null,
            receipt_voucher_pdf_preview_url:
              orderReceiptVoucherPreviewUrls[0] ?? null,
            receipt_voucher_pdf_download_url:
              orderReceiptVoucherDownloadUrls[0] ?? null,
            receipt_voucher_pdf_urls: orderReceiptVoucherPreviewUrls,
            receipt_voucher_pdf_preview_urls: orderReceiptVoucherPreviewUrls,
            receipt_voucher_pdf_download_urls: orderReceiptVoucherDownloadUrls,
          },
        }
      }),
    )

    return res.json({
      request: {
        ...request,

        // Compatibility aliases for frontend types
        admin_decided_at: request.admin_decision_at,
        admin_email: request.admin_email ?? request.admin_user_email,
        buyer_email: request.buyer_email ?? request.buyer_user_email,
        purchased_at:
          purchaseOrdersResult.rows.length > 0
            ? purchaseOrdersResult.rows[0].purchased_at
            : null,
        cancelled_at: request.cancelled_at,
cancelled_by_name: request.cancelled_by_name,
cancelled_by_email: request.cancelled_by_email,
cancellation_reason: request.cancellation_reason,
        status_label: getPurchaseRequestStatusLabel(request.status),

        available_action: getAvailableAction(request.status, request.id),
      },
      items: itemsResult.rows,
      purchase_orders,
      receipt_vouchers,
    })
  } catch (error) {
    console.error("Purchase journal detail error:", error)

    return res.status(500).json({
      message: "Unable to load purchase journal detail",
    })
  } finally {
    client.release()
  }
})

export default router
