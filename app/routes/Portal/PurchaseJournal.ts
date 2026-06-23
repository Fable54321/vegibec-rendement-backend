import { Router } from "express"
import type { Request } from "express"
import type { PoolClient } from "pg"
import { pool } from "../../db"
import {
  getPurchaseRequestStatusLabel,
  createBuyerValidationToken,
  getOrCreateActiveAdminApprovalToken,
  getOrCreateActivePurchaseToken,
  buildBuyerValidationUrl,
  buildAdminApprovalUrl,
  buildFinalPurchaseRequestUrl,
} from "./Utils/PurchaseHelper"

const router = Router()

type PurchaseRequestStatus =
  | "pending_buyer_validation"
  | "needs_requester_info"
  | "pending_admin_approval"
  | "admin_on_wait"
  | "rejected"
  | "ready_to_purchase"
  | "partially_purchased"
  | "purchased"
  | "cancelled"



function getAvailableAction(
  status: PurchaseRequestStatus,
  id: number,
) {
  switch (status) {
    case "pending_buyer_validation":
      return {
        label: "Valider l'achat",
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
      return {
        label: "Voir les bons de commande",
        href: `/purchase-journal/${id}`,
        kind: "view_purchase_orders",
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
        label: "Voir l'annulation",
        href: `/purchase-journal/${id}`,
        kind: "cancelled",
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

function buildPurchaseOrderPdfUrl(purchaseOrderId: number) {
  return `/buying/purchase-orders/${purchaseOrderId}/pdf`
}

function buildReceiptVoucherPdfUrl(purchaseOrderId: number) {
  return `/buying/purchase-orders/${purchaseOrderId}/receipt-voucher/pdf`
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

    default:
      return buildFinalPurchaseRequestUrl(req, purchaseRequestId)
  }
}

router.get("/", async (req, res) => {
  try {
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
        pr.status,
        pr.urgency,
        pr.needed_by_date,
        pr.expected_date,
        pr.requested_at,
        pr.created_at,
        pr.buyer_validated_at,
        pr.admin_decision_at,
        pr.updated_at,

        COALESCE(items.item_count, 0)::int AS item_count,

        COALESCE(items.requested_total_price, 0)::numeric
          AS requested_total_price,

        COALESCE(items.buyer_confirmed_total_price, 0)::numeric
          AS buyer_confirmed_total_price,

        COALESCE(orders.purchase_order_count, 0)::int
          AS purchase_order_count,

        COALESCE(orders.actual_purchased_total_price, 0)::numeric
          AS purchase_orders_total,

        COALESCE(orders.actual_purchased_total_price, 0)::numeric
          AS actual_purchased_total_price,

        orders.last_purchased_at,
        orders.last_received_at,

        first_item.description AS description

      FROM portal.purchase_requests pr

      LEFT JOIN (
        SELECT
          purchase_request_id,
          COUNT(*)::int AS item_count,

          COALESCE(
            SUM(requested_total_price),
            0
          )::numeric AS requested_total_price,

          COALESCE(
            SUM(buyer_confirmed_total_price),
            0
          )::numeric AS buyer_confirmed_total_price

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

          MAX(po.purchased_at) AS last_purchased_at,
          MAX(po.received_at) AS last_received_at

        FROM portal.purchase_orders po

        LEFT JOIN portal.purchase_order_items poi
          ON poi.purchase_order_id = po.id

        GROUP BY po.purchase_request_id
      ) orders
        ON orders.purchase_request_id = pr.id

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
        purchase_order_count: purchaseOrderCount,

        requested_total_price: requestedTotal,
        buyer_confirmed_total_price: buyerConfirmedTotal,
        actual_purchased_total_price: actualPurchasedTotal,
        purchase_orders_total: actualPurchasedTotal,

        display_total_price: displayTotalPrice,
        display_total_price_source: displayTotalPriceSource,

        // Compatibility aliases for the frontend context
        admin_decided_at: row.admin_decision_at,
        purchased_at: row.last_purchased_at,
        cancelled_at: null,
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
      action.kind === "rejected" ||
      action.kind === "cancelled"
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
      request.status !== "partially_purchased"
    ) {
      return res.status(400).json({
        message: "This request is not ready to purchase",
      })
    }

    return res.json({
      href: await buildCurrentActionLink(
        client,
        req,
        purchaseRequestId,
        request.status,
      ),
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
        COALESCE(item_totals.buyer_confirmed_total_price, 0)::numeric AS buyer_confirmed_total_price

      FROM portal.purchase_requests pr

      LEFT JOIN portal.users buyer
        ON buyer.id = pr.buyer_user_id

      LEFT JOIN portal.users admin
        ON admin.id = pr.admin_user_id

      LEFT JOIN portal.purchase_orders latest_po
        ON latest_po.purchase_request_id = pr.id

      LEFT JOIN portal.users purchased_by
        ON purchased_by.id = latest_po.purchased_by_user_id

      LEFT JOIN (
        SELECT
          purchase_request_id,
          COALESCE(SUM(requested_total_price), 0)::numeric AS requested_total_price,
          COALESCE(SUM(buyer_confirmed_total_price), 0)::numeric AS buyer_confirmed_total_price
        FROM portal.purchase_request_items
        GROUP BY purchase_request_id
      ) item_totals
        ON item_totals.purchase_request_id = pr.id

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
        updated_at
      FROM portal.purchase_request_items
      WHERE purchase_request_id = $1
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

      LEFT JOIN portal.users purchased_by
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

    const purchase_orders = purchaseOrdersResult.rows.map((po) => ({
      ...po,
      items: purchaseOrderItems[po.id] ?? [],
      documents: {
        purchase_order_pdf_url: buildPurchaseOrderPdfUrl(po.id),
        receipt_voucher_pdf_url: po.received_at
          ? buildReceiptVoucherPdfUrl(po.id)
          : null,
      },
    }))

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
        cancelled_at: null,
        status_label: getPurchaseRequestStatusLabel(request.status),

        available_action: getAvailableAction(request.status, request.id),
      },
      items: itemsResult.rows,
      purchase_orders,
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
