import crypto from "crypto"
import type { Request } from "express"
import multer from "multer"
import path from "path"
import type { PoolClient } from "pg"
import { getSignedUrlForKey } from "../../../services/s3.services"
import { sendEmail } from "../../Visitors/Utils/testSMTP"

const BUYER_VALIDATION_TOKEN_EXPIRES_IN_DAYS = 14
const ADMIN_APPROVAL_TOKEN_EXPIRES_IN_DAYS = 14
const PURCHASE_TOKEN_EXPIRES_IN_DAYS = 14
const PURCHASE_REQUEST_PICTURE_URL_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7
const PURCHASE_BUYER_NAME = "Ricardo"
const PURCHASE_ADMIN_NAME = "Michelle"

export type PictureEmailLink = {
  label: string
  url: string
}

export type PurchaseRequestEmailItem = {
  id?: number
  item_index?: number
  description?: string | null
  reason?: string | null
  quantity?: number | string | null
  quantity_format?: string | null
  requested_unit_price?: number | string | null
  requested_total_price?: number | string | null
  requested_supplier?: string | null
  product_link?: string | null
  buyer_confirmed_unit_price?: number | string | null
  buyer_confirmed_total_price?: number | string | null
  buyer_confirmed_supplier?: string | null
  status?: string | null
}

export type PurchaseRequestEmailData = {
  id?: number
  request_reference?: string | null
  requested_by?: string | null
  requester_email?: string | null
  requested_at?: string | Date | null
  needed_by_date?: string | Date | null
  expected_date?: string | Date | null
  urgency?: string | null
  status?: string | null
  buyer_validated_at?: string | Date | null
  buyer_note?: string | null
  admin_note?: string | null
  rejection_reason?: string | null
  modification_reason?: string | null
  modified_at?: string | Date | null
  modified_by_name?: string | null
  modified_by_email?: string | null
  cancellation_reason?: string | null
  cancelled_at?: string | Date | null
  cancelled_by_name?: string | null
  cancelled_by_email?: string | null
  direct_approval_approver?: string | null
  items?: PurchaseRequestEmailItem[]
  created_at?: string | Date | null
}

const getPictureExtension = (file: Express.Multer.File) => {
  const extension = path.extname(file.originalname).toLowerCase()

  if (extension && extension.length <= 10) {
    return extension
  }

  if (file.mimetype === "image/png") return ".png"
  if (file.mimetype === "image/webp") return ".webp"
  if (file.mimetype === "image/jpeg") return ".jpg"

  return ".jpg"
}



const getPurchaseDocumentExtension = (file: Express.Multer.File) => {
  const extension = path.extname(file.originalname).toLowerCase()

  if (extension && extension.length <= 10) {
    return extension
  }

  if (file.mimetype === "application/pdf") return ".pdf"
  if (file.mimetype === "image/png") return ".png"
  if (file.mimetype === "image/webp") return ".webp"
  if (file.mimetype === "image/jpeg") return ".jpg"

  return ".bin"
}

export const createPurchaseRequestPictureKey = (
  purchaseRequestId: number,
  file: Express.Multer.File,
  index: number
) => {
  const randomId = crypto.randomBytes(16).toString("hex")
  const extension = getPictureExtension(file)

  return `purchase-requests/${purchaseRequestId}/pictures/${
    index + 1
  }-${randomId}${extension}`
}

export const createPurchaseRequestDocumentKey = (
  purchaseRequestId: number,
  file: Express.Multer.File,
  index: number
) => {
  const randomId = crypto.randomBytes(16).toString("hex")
  const extension = getPurchaseDocumentExtension(file)

  return `purchase-requests/${purchaseRequestId}/purchase-documents/${
    index + 1
  }-${randomId}${extension}`
}

export const uploadPurchaseRequestPictures = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 10,
    fileSize: 7 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"))
      return
    }

    cb(null, true)
  },
})



export const uploadPurchaseRequestDocuments = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 5,
    fileSize: 7 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const isAcceptedImage = file.mimetype.startsWith("image/")
    const isAcceptedPdf = file.mimetype === "application/pdf"

    if (!isAcceptedImage && !isAcceptedPdf) {
      cb(new Error("Only image and PDF files are allowed"))
      return
    }

    cb(null, true)
  },
})

export const getUrgencyFromExpectedDate = (expectedDate: string | null) => {
  if (!expectedDate) return "normal"

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const selectedDate = new Date(`${expectedDate}`)
  selectedDate.setHours(0, 0, 0, 0)

  const differenceInMs = selectedDate.getTime() - today.getTime()
  const differenceInDays = Math.ceil(differenceInMs / (1000 * 60 * 60 * 24))

  if (differenceInDays <= 1) return "au plus vite"
  if (differenceInDays <= 7) return "urgent (1 semaine ou moins)"
  if (differenceInDays <= 14) return "moyen"

  return "normal"
}

export const getEmailRecipients = (...envNames: string[]) => {
  return envNames
    .map((name) =>
      name.includes("@") ? name.trim() : process.env[name]?.trim()
    )
    .filter(Boolean)
    .join(",")
}

const ensureBuyerValidationTokenTable = async (client: PoolClient) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS portal.purchase_request_buyer_validation_tokens (
      id bigserial PRIMARY KEY,
      purchase_request_id bigint NOT NULL REFERENCES portal.purchase_requests(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    )
  `)

  await client.query(`
    CREATE INDEX IF NOT EXISTS purchase_request_buyer_validation_tokens_request_id_idx
    ON portal.purchase_request_buyer_validation_tokens (purchase_request_id)
  `)
}

const hashBuyerValidationToken = (token: string) => {
  return crypto.createHash("sha256").update(token).digest("hex")
}

const ensureAdminApprovalTokenTable = async (client: PoolClient) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS portal.purchase_request_admin_approval_tokens (
      id bigserial PRIMARY KEY,
      purchase_request_id bigint NOT NULL REFERENCES portal.purchase_requests(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    )
  `)

  await client.query(`
    CREATE INDEX IF NOT EXISTS purchase_request_admin_approval_tokens_request_id_idx
    ON portal.purchase_request_admin_approval_tokens (purchase_request_id)
  `)
}

const ensurePurchaseTokenTable = async (client: PoolClient) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS portal.purchase_request_purchase_tokens (
      id bigserial PRIMARY KEY,
      purchase_request_id bigint NOT NULL REFERENCES portal.purchase_requests(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    )
  `)

  await client.query(`
    CREATE INDEX IF NOT EXISTS purchase_request_purchase_tokens_request_id_idx
    ON portal.purchase_request_purchase_tokens (purchase_request_id)
  `)
}

export const createBuyerValidationToken = async (
  client: PoolClient,
  purchaseRequestId: number
) => {
  await ensureBuyerValidationTokenTable(client)

  const token = crypto.randomBytes(32).toString("hex")
  const tokenHash = hashBuyerValidationToken(token)

  await client.query(
    `
    INSERT INTO portal.purchase_request_buyer_validation_tokens (
      purchase_request_id,
      token_hash,
      expires_at
    )
    VALUES (
      $1,
      $2,
      now() + ($3::text || ' days')::interval
    )
    `,
    [purchaseRequestId, tokenHash, BUYER_VALIDATION_TOKEN_EXPIRES_IN_DAYS]
  )

  return token
}

export const createAdminApprovalToken = async (
  client: PoolClient,
  purchaseRequestId: number
) => {
  await ensureAdminApprovalTokenTable(client)

  const token = crypto.randomBytes(32).toString("hex")

  await client.query(
    `
    INSERT INTO portal.purchase_request_admin_approval_tokens (
      purchase_request_id,
      token_hash,
      expires_at
    )
    VALUES (
      $1,
      $2,
      now() + ($3 || ' days')::interval
    )
    `,
    [purchaseRequestId, token, ADMIN_APPROVAL_TOKEN_EXPIRES_IN_DAYS]
  )

  return token
}

export const createPurchaseToken = async (
  client: PoolClient,
  purchaseRequestId: number
) => {
  await ensurePurchaseTokenTable(client)

  const token = crypto.randomBytes(32).toString("hex")

  await client.query(
    `
    INSERT INTO portal.purchase_request_purchase_tokens (
      purchase_request_id,
      token_hash,
      expires_at
    )
    VALUES (
      $1,
      $2,
      now() + ($3 || ' days')::interval
    )
    `,
    [purchaseRequestId, token, PURCHASE_TOKEN_EXPIRES_IN_DAYS]
  )

  return token
}

export const getActivePurchaseToken = async (
  client: PoolClient,
  purchaseRequestId: number
) => {
  await ensurePurchaseTokenTable(client)

  const result = await client.query(
    `
    SELECT token_hash
    FROM portal.purchase_request_purchase_tokens
    WHERE purchase_request_id = $1
      AND used_at IS NULL
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [purchaseRequestId]
  )

  return result.rows[0]?.token_hash ?? null
}

export const getActiveAdminApprovalToken = async (
  client: PoolClient,
  purchaseRequestId: number
) => {
  await ensureAdminApprovalTokenTable(client)

  const result = await client.query(
    `
    SELECT token_hash
    FROM portal.purchase_request_admin_approval_tokens
    WHERE purchase_request_id = $1
      AND used_at IS NULL
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [purchaseRequestId]
  )

  return result.rows[0]?.token_hash ?? null
}

export const getOrCreateActivePurchaseToken = async (
  client: PoolClient,
  purchaseRequestId: number
) => {
  const existingToken = await getActivePurchaseToken(client, purchaseRequestId)

  if (existingToken) {
    return existingToken
  }

  return createPurchaseToken(client, purchaseRequestId)
}

export const getOrCreateActiveAdminApprovalToken = async (
  client: PoolClient,
  purchaseRequestId: number
) => {
  const existingToken = await getActiveAdminApprovalToken(
    client,
    purchaseRequestId
  )

  if (existingToken) {
    return existingToken
  }

  return createAdminApprovalToken(client, purchaseRequestId)
}

export const getBuyerValidationTokenFromRequest = (req: Request) => {
  const bodyToken = (req.body as { buyer_validation_token?: unknown })
    ?.buyer_validation_token
  const queryToken = req.query.token
  const headerToken = req.headers["x-purchase-request-buyer-token"]
  const paramToken = req.params.token

  if (typeof paramToken === "string" && paramToken.trim()) return paramToken.trim()
  if (typeof bodyToken === "string" && bodyToken.trim()) return bodyToken.trim()
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim()
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim()

  return null
}

export const getAdminApprovalTokenFromRequest = (req: Request) => {
  const bodyToken = (req.body as { admin_approval_token?: unknown })
    ?.admin_approval_token
  const queryToken = req.query.token
  const headerToken = req.headers["x-purchase-request-admin-token"]
  const paramToken = req.params.token

  if (typeof paramToken === "string" && paramToken.trim()) return paramToken.trim()
  if (typeof bodyToken === "string" && bodyToken.trim()) return bodyToken.trim()
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim()
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim()

  return null
}

export const getPurchaseTokenFromRequest = (req: Request) => {
  const bodyToken = (req.body as { purchase_token?: unknown })?.purchase_token
  const queryToken = req.query.token
  const headerToken = req.headers["x-purchase-request-purchase-token"]
  const paramToken = req.params.token

  if (typeof paramToken === "string" && paramToken.trim()) return paramToken.trim()
  if (typeof bodyToken === "string" && bodyToken.trim()) return bodyToken.trim()
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim()
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim()

  return null
}

export const validateBuyerValidationToken = async (
  client: PoolClient,
  purchaseRequestId: number,
  token: string | null
) => {
  if (!token) return false

  await ensureBuyerValidationTokenTable(client)

  const result = await client.query(
    `
    SELECT id
    FROM portal.purchase_request_buyer_validation_tokens
    WHERE purchase_request_id = $1
      AND token_hash = $2
      AND used_at IS NULL
      AND expires_at > now()
    LIMIT 1
    `,
    [purchaseRequestId, hashBuyerValidationToken(token)]
  )

  return result.rows.length > 0
}

export const validatePurchaseToken = async (
  client: PoolClient,
  purchaseRequestId: number,
  token: string | null
) => {
  if (!token) return false

  await ensurePurchaseTokenTable(client)

  const result = await client.query(
    `
    SELECT id
    FROM portal.purchase_request_purchase_tokens
    WHERE purchase_request_id = $1
      AND token_hash = $2
      AND used_at IS NULL
      AND expires_at > now()
    LIMIT 1
    `,
    [purchaseRequestId, token]
  )

  return result.rows.length > 0
}

export const markPurchaseTokenUsed = async (
  client: PoolClient,
  purchaseRequestId: number,
  token: string
) => {
  await client.query(
    `
    UPDATE portal.purchase_request_purchase_tokens
    SET used_at = now()
    WHERE purchase_request_id = $1
      AND token_hash = $2
      AND used_at IS NULL
    `,
    [purchaseRequestId, token]
  )
}

export const markBuyerValidationTokenUsed = async (
  client: PoolClient,
  purchaseRequestId: number,
  token: string
) => {
  await client.query(
    `
    UPDATE portal.purchase_request_buyer_validation_tokens
    SET used_at = now()
    WHERE purchase_request_id = $1
      AND token_hash = $2
      AND used_at IS NULL
    `,
    [purchaseRequestId, hashBuyerValidationToken(token)]
  )
}

export const validateAdminApprovalToken = async (
  client: PoolClient,
  purchaseRequestId: number,
  token: string | null
) => {
  if (!token) return false

  await ensureAdminApprovalTokenTable(client)

  const result = await client.query(
    `
    SELECT id
    FROM portal.purchase_request_admin_approval_tokens
    WHERE purchase_request_id = $1
      AND token_hash = $2
      AND used_at IS NULL
      AND expires_at > now()
    LIMIT 1
    `,
    [purchaseRequestId, token]
  )

  return result.rows.length > 0
}

export const markAdminApprovalTokenUsed = async (
  client: PoolClient,
  purchaseRequestId: number,
  token: string
) => {
  await client.query(
    `
    UPDATE portal.purchase_request_admin_approval_tokens
    SET used_at = now()
    WHERE purchase_request_id = $1
      AND token_hash = $2
      AND used_at IS NULL
    `,
    [purchaseRequestId, token]
  )
}

export const buildBuyerValidationUrl = (
  req: Request,
  purchaseRequestId: number,
  token: string
) => {
  const configuredBaseUrl = "https://achats.vegibec-portail.com"

  const baseUrl =
    configuredBaseUrl ||
    (process.env.NODE_ENV === "production"
      ? "https://achats.vegibec-portail.com"
      : `${req.protocol}://${req.get("host") || "localhost:3000"}`)

  return `${baseUrl.replace(
    /\/$/,
    ""
  )}/requete/${purchaseRequestId}/validation-prix/${token}`
}

export const buildAdminApprovalUrl = (
  req: Request,
  purchaseRequestId: number,
  token: string
) => {
  const configuredBaseUrl = "https://achats.vegibec-portail.com"
  const baseUrl =
    configuredBaseUrl ||
    (process.env.NODE_ENV === "production"
      ? "https://achats.vegibec-portail.com"
      : `${req.protocol}://${req.get("host") || "localhost:3000"}`)

  return `${baseUrl.replace(
    /\/$/,
    ""
  )}/requete/${purchaseRequestId}/approbation-achat/${token}`
}

export const buildFinalPurchaseRequestUrl = (
  req: Request,
  purchaseRequestId: number,
  token?: string | null
) => {
  const configuredBaseUrl = "https://achats.vegibec-portail.com"
  const baseUrl =
    configuredBaseUrl ||
    (process.env.NODE_ENV === "production"
      ? "https://achats.vegibec-portail.com"
      : `${req.protocol}://${req.get("host") || "localhost:3000"}`)

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "")

  if (token) {
    return `${normalizedBaseUrl}/requete/${purchaseRequestId}/acheter/${token}`
  }

  return `${normalizedBaseUrl}/requete/${purchaseRequestId}`
}

const formatDateFr = (value: string | Date | null | undefined) => {
  if (!value) return "Non indiquée"

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return "Non indiquée"
  }

  return new Intl.DateTimeFormat("fr-CA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}

const formatDateTimeFr = (value: string | Date | null | undefined) => {
  if (!value) return "Non indiqué"

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return "Non indiqué"
  }

  return new Intl.DateTimeFormat("fr-CA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Toronto",
  }).format(date)
}

const formatMoney = (value: number | string | null | undefined) => {
  if (value === null || value === undefined || value === "") {
    return "Non indiqué"
  }

  const numberValue = Number(value)

  if (!Number.isFinite(numberValue)) {
    return "Non indiqué"
  }

  return `${numberValue.toFixed(2)} $`
}

const formatQuantity = (item: PurchaseRequestEmailItem) => {
  const quantity =
    item.quantity === null || item.quantity === undefined || item.quantity === ""
      ? "Non indiquée"
      : String(item.quantity)

  const quantityFormat =
    typeof item.quantity_format === "string" ? item.quantity_format.trim() : ""

  return quantityFormat ? `${quantity} - ${quantityFormat}` : quantity
}

const getEmailItems = (request: PurchaseRequestEmailData) => {
  if (Array.isArray(request.items)) return request.items

  if (typeof request.items === "string") {
    try {
      const parsedItems = JSON.parse(request.items)
      return Array.isArray(parsedItems) ? parsedItems : []
    } catch {
      return []
    }
  }

  return []
}

const getFiniteNumber = (value: number | string | null | undefined) => {
  if (value === null || value === undefined || value === "") return null

  const numberValue = Number(value)

  return Number.isFinite(numberValue) ? numberValue : null
}

const getItemTotalPrice = (
  item: PurchaseRequestEmailItem,
  totalField: "requested_total_price" | "buyer_confirmed_total_price",
  unitField: "requested_unit_price" | "buyer_confirmed_unit_price"
) => {
  const explicitTotal = getFiniteNumber(item[totalField])

  if (explicitTotal !== null) return explicitTotal

  const quantity = getFiniteNumber(item.quantity)
  const unitPrice = getFiniteNumber(item[unitField])

  if (quantity === null || unitPrice === null) return null

  return quantity * unitPrice
}

const sumMoneyValues = (
  items: PurchaseRequestEmailItem[],
  getValue: (item: PurchaseRequestEmailItem) => number | null
) => {
  let hasValue = false

  const total = items.reduce((sum, item) => {
    const value = getValue(item)

    if (value === null) {
      return sum
    }

    hasValue = true
    return sum + value
  }, 0)

  return hasValue ? total : null
}

const getRequestedItemsTotal = (request: PurchaseRequestEmailData) => {
  return sumMoneyValues(getEmailItems(request), (item) =>
    getItemTotalPrice(item, "requested_total_price", "requested_unit_price")
  )
}

const getConfirmedItemsTotal = (request: PurchaseRequestEmailData) => {
  return sumMoneyValues(getEmailItems(request), (item) =>
    getItemTotalPrice(
      item,
      "buyer_confirmed_total_price",
      "buyer_confirmed_unit_price"
    )
  )
}


const formatRequestItemsForEmail = (
  items: PurchaseRequestEmailItem[],
  options?: {
    includeRequestedPrices?: boolean
    includeConfirmedPrices?: boolean
    includeProductLinks?: boolean
  }
) => {
  if (items.length === 0) {
    return "Aucun article indiqué"
  }

  return items
    .map((item, index) => {
      const itemNumber = item.item_index ?? index + 1

      const lines = [
        `Article ${itemNumber}`,
        `Description: ${item.description || "Non indiquée"}`,
        `Justification: ${item.reason || "Aucune justification indiquée"}`,
        `Quantité: ${formatQuantity(item)}`,
      ]

      if (options?.includeRequestedPrices) {
        lines.push(`Prix unitaire estimé: ${formatMoney(item.requested_unit_price)}`)
        lines.push(
          `Prix total estimé: ${formatMoney(
            getItemTotalPrice(item, "requested_total_price", "requested_unit_price")
          )}`
        )
      }

      if (options?.includeConfirmedPrices) {
        lines.push(
          `Prix unitaire confirmé: ${formatMoney(item.buyer_confirmed_unit_price)}`
        )
        lines.push(
          `Prix total confirmé: ${formatMoney(
            getItemTotalPrice(
              item,
              "buyer_confirmed_total_price",
              "buyer_confirmed_unit_price"
            )
          )}`
        )
        lines.push(
          `Fournisseur potentiel: ${item.buyer_confirmed_supplier || "Non indiqué"}`
        )
      }

      if (options?.includeProductLinks) {
        lines.push(`Lien produit: ${item.product_link || "Aucun lien indiqué"}`)
      }

      return lines.join("\n")
    })
    .join("\n\n---\n\n")
}


const formatRequestItemsForEmailHtml = (
  items: PurchaseRequestEmailItem[],
  options?: {
    includeRequestedPrices?: boolean
    includeConfirmedPrices?: boolean
    includeProductLinks?: boolean
  }
) => {
  if (items.length === 0) {
    return `<p>Aucun article indiqué</p>`
  }

  return items
    .map((item, index) => {
      const itemNumber = item.item_index ?? index + 1
      const productLinkUrl = getSafeHttpUrl(item.product_link)

      return `
        <div style="border:1px solid #cbd5e1;border-radius:8px;padding:14px 16px;margin:16px 0;background:#f8fafc;">
          <h3 style="margin:0 0 10px 0;color:#166534;">
            Article ${escapeHtml(itemNumber)}
          </h3>

          <table style="width:100%;border-collapse:collapse;">
            <tbody>
              <tr>
                <td style="padding:6px 8px 6px 0;font-weight:700;vertical-align:top;width:180px;">Description</td>
                <td style="padding:6px 0;">${escapeHtml(
                  item.description || "Non indiquée"
                )}</td>
              </tr>

              <tr>
                <td style="padding:6px 8px 6px 0;font-weight:700;vertical-align:top;">Justification</td>
                <td style="padding:6px 0;">${escapeHtml(
                  item.reason || "Aucune justification indiquée"
                )}</td>
              </tr>

              <tr>
                <td style="padding:6px 8px 6px 0;font-weight:700;vertical-align:top;">Quantité</td>
                <td style="padding:6px 0;">${escapeHtml(formatQuantity(item))}</td>
              </tr>

              ${
                options?.includeRequestedPrices
                  ? `
                    <tr>
                      <td style="padding:6px 8px 6px 0;font-weight:700;vertical-align:top;">Prix estimé</td>
                      <td style="padding:6px 0;">
                        ${formatMoney(item.requested_unit_price)} / unité<br />
                        Total: ${formatMoney(
                          getItemTotalPrice(
                            item,
                            "requested_total_price",
                            "requested_unit_price"
                          )
                        )}
                      </td>
                    </tr>

                  
                  `
                  : ""
              }

              ${
                options?.includeConfirmedPrices
                  ? `
                    <tr>
                      <td style="padding:6px 8px 6px 0;font-weight:700;vertical-align:top;">Prix confirmé</td>
                      <td style="padding:6px 0;">
                        ${formatMoney(item.buyer_confirmed_unit_price)} / unité<br />
                        Total: ${formatMoney(
                          getItemTotalPrice(
                            item,
                            "buyer_confirmed_total_price",
                            "buyer_confirmed_unit_price"
                          )
                        )}
                      </td>
                    </tr>

                    <tr>
                      <td style="padding:6px 8px 6px 0;font-weight:700;vertical-align:top;">Fournisseur confirmé</td>
                      <td style="padding:6px 0;">${escapeHtml(
                        item.buyer_confirmed_supplier || "Non indiqué"
                      )}</td>
                    </tr>
                  `
                  : ""
              }

              ${
                options?.includeProductLinks
                  ? `
                    <tr>
                      <td style="padding:6px 8px 6px 0;font-weight:700;vertical-align:top;">Lien produit</td>
                      <td style="padding:6px 0;">
                        ${
                          productLinkUrl
                            ? `<a href="${escapeHtml(
                                productLinkUrl
                              )}" target="_blank" rel="noopener noreferrer">Voir le produit</a>`
                            : "Aucun lien indiqué"
                        }
                      </td>
                    </tr>
                  `
                  : ""
              }
            </tbody>
          </table>
        </div>
      `
    })
    .join("")
}

export const getPurchaseRequestDisplayNumber = (request: any) =>
  request.request_reference ?? String(request.id)

const formatRequesterEmail = (request: any) => {
  return typeof request.requester_email === "string" && request.requester_email.trim()
    ? request.requester_email.trim()
    : "Non indiqué"
}

const escapeHtml = (value: unknown) => {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const getSafeHttpUrl = (value: unknown) => {
  if (typeof value !== "string" || value.trim() === "") return null

  try {
    const url = new URL(value.trim())

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null
    }

    return url.toString()
  } catch {
    return null
  }
}

const formatPictureLinksForEmail = (pictureLinks: PictureEmailLink[]) => {
  if (pictureLinks.length === 0) return "Aucune photo jointe"

  return pictureLinks
    .map((pictureLink, index) => {
      return `Photo ${index + 1}${pictureLink.label ? ` (${pictureLink.label})` : ""}: ${
        pictureLink.url
      }`
    })
    .join("\n \n \n \n")
}

const formatPictureLinksForEmailHtml = (pictureLinks: PictureEmailLink[]) => {
  if (pictureLinks.length === 0) {
    return `<p>Aucune photo jointe</p>`
  }

  return `
    <ul>
      ${pictureLinks
        .map(
          (pictureLink, index) => `
            <li>
              <a href="${escapeHtml(pictureLink.url)}" target="_blank" rel="noopener noreferrer">
                Photo ${index + 1}
              </a>
              ${
                pictureLink.label
                  ? `<span style="color:#64748b;"> - ${escapeHtml(
                      pictureLink.label
                    )}</span>`
                  : ""
              }
            </li>
          `
        )
        .join("")}
    </ul>
    <p style="color:#64748b;font-size:13px;">
      Les liens des photos expirent dans 7 jours.
    </p>
  `
}



export const buildNewPurchaseRequestEmail = (
  request: PurchaseRequestEmailData,
  pictureLinks: PictureEmailLink[] = [],
  buyerValidationUrl: string
) => {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const requestedTotal = getRequestedItemsTotal(request)

  const pictureExpiryText =
    pictureLinks.length > 0 ? "\n\nLes liens des photos expirent dans 7 jours." : ""

  return `
Une nouvelle demande d'achat a été soumise.

Numéro de demande:
#${displayRequestNumber}

Demandeur:
${request.requested_by || "Non indiqué"}

Courriel du demandeur:
${formatRequesterEmail(request)}

Nombre d'articles:
${items.length}

Total estimé de la demande:
${requestedTotal === null ? "Non indiqué" : formatMoney(requestedTotal)}

Date requise:
${formatDateFr(request.needed_by_date)}

Urgence:
${request.urgency || "Normal"}

Articles:

${formatRequestItemsForEmail(items, {
  includeRequestedPrices: true,
  includeProductLinks: true,
})}

Photos:
${formatPictureLinksForEmail(pictureLinks)}${pictureExpiryText}

Lien de validation pour Ricardo:
${buyerValidationUrl}

Prochaine étape:
Ricardo doit confirmer les prix des articles avec le lien de validation.
  `.trim()
}

export const buildNewPurchaseRequestEmailHtml = (
  request: PurchaseRequestEmailData,
  pictureLinks: PictureEmailLink[] = [],
  buyerValidationUrl: string
) => {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const requestedTotal = getRequestedItemsTotal(request)
  const safeBuyerValidationUrl = escapeHtml(buyerValidationUrl)

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <h2>Demande d'achat #${escapeHtml(displayRequestNumber)}</h2>

      <p>Une nouvelle demande d'achat a été soumise.</p>

      <p><strong>Demandeur:</strong><br />${escapeHtml(
        request.requested_by || "Non indiqué"
      )}</p>

      <p><strong>Courriel du demandeur:</strong><br />${escapeHtml(
        formatRequesterEmail(request)
      )}</p>

      <p><strong>Nombre d'articles:</strong><br />${items.length}</p>

      <p><strong>Total estimé de la demande:</strong><br />${
        requestedTotal === null ? "Non indiqué" : formatMoney(requestedTotal)
      }</p>

      <p><strong>Date requise:</strong><br />${formatDateFr(
        request.needed_by_date
      )}</p>

      <p><strong>Urgence:</strong><br />${escapeHtml(
        request.urgency || "Normal"
      )}</p>

      <h3>Articles</h3>

      ${formatRequestItemsForEmailHtml(items, {
        includeRequestedPrices: true,
        includeProductLinks: true,
      })}

      <p><strong>Photos:</strong></p>
      ${formatPictureLinksForEmailHtml(pictureLinks)}

      <p>
        <a
          href="${safeBuyerValidationUrl}"
          target="_blank"
          rel="noopener noreferrer"
          style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;font-weight:700;"
        >
          Ricardo - vérifier les prix
        </a>
      </p>

      <p style="color:#475569;font-size:13px;">
        Lien direct:<br />
        <a href="${safeBuyerValidationUrl}" target="_blank" rel="noopener noreferrer">
          ${safeBuyerValidationUrl}
        </a>
      </p>

      <hr />

      <p><strong>Prochaine étape:</strong><br />
      Ricardo doit confirmer les prix des articles avec le lien de validation.</p>
    </div>
  `.trim()
}


export const buildAdminApprovalEmail = (
  request: PurchaseRequestEmailData,
  adminApprovalUrl: string
) => {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const requestedTotal = getRequestedItemsTotal(request)
  const confirmedTotal = getConfirmedItemsTotal(request)
  const priceIncreaseInfo = getPriceIncreaseInfo(request)

  const priceIncreaseWarning = priceIncreaseInfo
    ? `

Attention:
Le prix total confirmé est plus élevé que le prix total estimé de la demande.
Prix estimé: ${formatMoney(priceIncreaseInfo.requestedTotalPrice)}
Prix confirmé: ${formatMoney(priceIncreaseInfo.confirmedTotalPrice)}
Écart: ${formatMoney(priceIncreaseInfo.difference)}
`
    : ""

  return `
Une demande d'achat est prête pour la décision de Michelle.

Numéro de demande:
#${displayRequestNumber}

Demandeur:
${request.requested_by || "Non indiqué"}

Courriel du demandeur:
${formatRequesterEmail(request)}

Nombre d'articles:
${items.length}

Total estimé:
${requestedTotal === null ? "Non indiqué" : formatMoney(requestedTotal)}

Total confirmé:
${confirmedTotal === null ? "Non indiqué" : formatMoney(confirmedTotal)}${priceIncreaseWarning}

Note de Ricardo:
${request.buyer_note || "Aucune note"}

Date requise:
${formatDateFr(request.expected_date || request.needed_by_date)}

Urgence:
${request.urgency || "Normal"}

Articles:

${formatRequestItemsForEmail(items, {
  includeRequestedPrices: true,
  includeConfirmedPrices: true,
  includeProductLinks: true,
})}

Lien de décision pour Michelle:
${adminApprovalUrl}

Prochaine étape:
Michelle doit approuver, mettre en attente ou refuser la demande.
  `.trim()
}

export const buildAdminApprovalEmailHtml = (
  request: PurchaseRequestEmailData,
  adminApprovalUrl: string
) => {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const requestedTotal = getRequestedItemsTotal(request)
  const confirmedTotal = getConfirmedItemsTotal(request)
  const priceIncreaseInfo = getPriceIncreaseInfo(request)
  const safeAdminApprovalUrl = escapeHtml(adminApprovalUrl)

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <h2>Demande d'achat #${escapeHtml(displayRequestNumber)} prête pour Michelle</h2>

      <p>Michelle doit approuver, mettre en attente ou refuser cette demande.</p>

      ${
        priceIncreaseInfo
          ? `
            <div style="border:1px solid #fecaca;background:#fef2f2;color:#991b1b;padding:12px 14px;border-radius:6px;margin:14px 0;">
              <strong>Attention: prix plus élevé que la demande initiale.</strong><br />
              Prix estimé: ${formatMoney(priceIncreaseInfo.requestedTotalPrice)}<br />
              Prix confirmé: ${formatMoney(priceIncreaseInfo.confirmedTotalPrice)}<br />
              Écart: ${formatMoney(priceIncreaseInfo.difference)}
            </div>
          `
          : ""
      }

      <p><strong>Demandeur:</strong><br />${escapeHtml(
        request.requested_by || "Non indiqué"
      )}</p>

      <p><strong>Courriel du demandeur:</strong><br />${escapeHtml(
        formatRequesterEmail(request)
      )}</p>

      <p><strong>Nombre d'articles:</strong><br />${items.length}</p>

      <p><strong>Total estimé:</strong><br />${
        requestedTotal === null ? "Non indiqué" : formatMoney(requestedTotal)
      }</p>

      <p><strong>Total confirmé:</strong><br />${
        confirmedTotal === null ? "Non indiqué" : formatMoney(confirmedTotal)
      }</p>

      <p><strong>Note de Ricardo:</strong><br />${escapeHtml(
        request.buyer_note || "Aucune note"
      )}</p>

      <p><strong>Date requise:</strong><br />${formatDateFr(
        request.expected_date || request.needed_by_date
      )}</p>

      <p><strong>Urgence:</strong><br />${escapeHtml(
        request.urgency || "Normal"
      )}</p>

      <h3>Articles</h3>

      ${formatRequestItemsForEmailHtml(items, {
        includeRequestedPrices: true,
        includeConfirmedPrices: true,
        includeProductLinks: true,
      })}

      <p>
        <a
          href="${safeAdminApprovalUrl}"
          target="_blank"
          rel="noopener noreferrer"
          style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;font-weight:700;"
        >
          Michelle - approbation
        </a>
      </p>

      <p style="color:#475569;font-size:13px;">
        Lien direct:<br />
        <a href="${safeAdminApprovalUrl}" target="_blank" rel="noopener noreferrer">
          ${safeAdminApprovalUrl}
        </a>
      </p>
    </div>
  `.trim()
}

export const getPurchaseRequestStatusLabel = (
  status: string | null | undefined
) => {
  const labels: Record<string, string> = {
    pending_buyer_validation: "En attente de validation par Ricardo",
    needs_requester_info: "Information demandée au demandeur",
    pending_admin_approval: "En attente de décision par Michelle",
    approved: "Approuvée",
    rejected: "Refusée",
    ready_to_purchase: "Prête à acheter",
    partially_purchased: "Partiellement achetée",
    admin_on_wait: "Mise en attente par Michelle",
    purchased: "Achetée",
    cancelled: "Annulée",
  }

  return status ? labels[status] || status : "Non indiqué"
}

const getPriceIncreaseInfo = (request: PurchaseRequestEmailData) => {
  const requestedTotalPrice = getRequestedItemsTotal(request)
  const confirmedTotalPrice = getConfirmedItemsTotal(request)

  if (requestedTotalPrice === null || confirmedTotalPrice === null) {
    return null
  }

  if (confirmedTotalPrice <= requestedTotalPrice) {
    return null
  }

  return {
    difference: confirmedTotalPrice - requestedTotalPrice,
    requestedTotalPrice,
    confirmedTotalPrice,
  }
}
export const buildBuyerPriceConfirmedEmail = (
  request: PurchaseRequestEmailData,
  adminApprovalUrl: string
) => {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const requestedTotal = getRequestedItemsTotal(request)
  const confirmedTotal = getConfirmedItemsTotal(request)
  const priceIncreaseInfo = getPriceIncreaseInfo(request)

  const priceIncreaseWarning = priceIncreaseInfo
    ? `

Attention:
Le prix total confirmé est plus élevé que le prix total estimé de la demande.
Prix estimé: ${formatMoney(priceIncreaseInfo.requestedTotalPrice)}
Prix confirmé: ${formatMoney(priceIncreaseInfo.confirmedTotalPrice)}
Écart: ${formatMoney(priceIncreaseInfo.difference)}
`
    : ""

  return `
Ricardo a confirmé le prix de la demande d'achat #${displayRequestNumber}.

Prochaine décision:
Michelle doit approuver ou refuser la demande.

Résumé de la demande:

Demandeur:
${request.requested_by || "Non indiqué"}

Courriel du demandeur:
${formatRequesterEmail(request)}

Nombre d'articles:
${items.length}

Total estimé dans la demande:
${requestedTotal === null ? "Non indiqué" : formatMoney(requestedTotal)}

Total confirmé par Ricardo:
${confirmedTotal === null ? "Non indiqué" : formatMoney(confirmedTotal)}${priceIncreaseWarning}

Statut:
${getPurchaseRequestStatusLabel(request.status)}

Date de validation par Ricardo:
${formatDateTimeFr(request.buyer_validated_at)}

Date de la demande:
${formatDateTimeFr(request.requested_at || request.created_at)}

Urgence:
${request.urgency || "Normal"}

Date requise:
${formatDateFr(request.expected_date || request.needed_by_date)}

Articles:

${formatRequestItemsForEmail(items, {
  includeRequestedPrices: true,
  includeConfirmedPrices: true,
  includeProductLinks: true,
})}

Lien de décision pour Michelle:
${adminApprovalUrl}
  `.trim()
}
export const buildBuyerPriceConfirmedEmailHtml = (
  request: PurchaseRequestEmailData,
  adminApprovalUrl: string
) => {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const requestedTotal = getRequestedItemsTotal(request)
  const confirmedTotal = getConfirmedItemsTotal(request)
  const priceIncreaseInfo = getPriceIncreaseInfo(request)
  const confirmedTotalPriceStyle = priceIncreaseInfo
    ? "color:#b91c1c;font-weight:700;"
    : ""

  const safeAdminApprovalUrl = escapeHtml(adminApprovalUrl)

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <h2>Ricardo a confirmé le prix - demande d'achat #${escapeHtml(
        displayRequestNumber
      )}</h2>

      <p>Michelle doit maintenant approuver ou refuser la demande.</p>

      ${
        priceIncreaseInfo
          ? `
            <div style="border:1px solid #fecaca;background:#fef2f2;color:#991b1b;padding:12px 14px;border-radius:6px;margin:14px 0;">
              <strong>Attention: prix plus élevé que la demande initiale.</strong><br />
              Prix estimé: ${formatMoney(priceIncreaseInfo.requestedTotalPrice)}<br />
              Prix confirmé: ${formatMoney(priceIncreaseInfo.confirmedTotalPrice)}<br />
              Écart: ${formatMoney(priceIncreaseInfo.difference)}
            </div>
          `
          : ""
      }

      <p><strong>Demandeur:</strong><br />${escapeHtml(
        request.requested_by || "Non indiqué"
      )}</p>

      <p><strong>Courriel du demandeur:</strong><br />${escapeHtml(
        formatRequesterEmail(request)
      )}</p>

      <p><strong>Nombre d'articles:</strong><br />${items.length}</p>

      <p><strong>Total estimé dans la demande:</strong><br />${
        requestedTotal === null ? "Non indiqué" : formatMoney(requestedTotal)
      }</p>

      <p><strong>Total confirmé par Ricardo:</strong><br />
        <span style="${confirmedTotalPriceStyle}">
          ${confirmedTotal === null ? "Non indiqué" : formatMoney(confirmedTotal)}
        </span>
      </p>

      <p><strong>Statut:</strong><br />${escapeHtml(
        getPurchaseRequestStatusLabel(request.status)
      )}</p>

      <p><strong>Date de validation par Ricardo:</strong><br />${formatDateTimeFr(
        request.buyer_validated_at
      )}</p>

      <p><strong>Date de la demande:</strong><br />${formatDateTimeFr(
        request.requested_at || request.created_at
      )}</p>

      <p><strong>Urgence:</strong><br />${escapeHtml(
        request.urgency || "Normal"
      )}</p>

      <p><strong>Date requise:</strong><br />${formatDateFr(
        request.expected_date || request.needed_by_date
      )}</p>

      <h3>Articles</h3>

      ${formatRequestItemsForEmailHtml(items, {
        includeRequestedPrices: true,
        includeConfirmedPrices: true,
        includeProductLinks: true,
      })}

      <p>
        <a
          href="${safeAdminApprovalUrl}"
          target="_blank"
          rel="noopener noreferrer"
          style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;font-weight:700;"
        >
          Michelle - approbation
        </a>
      </p>

      <p style="color:#475569;font-size:13px;">
        Lien direct:<br />
        <a href="${safeAdminApprovalUrl}" target="_blank" rel="noopener noreferrer">
          ${safeAdminApprovalUrl}
        </a>
      </p>
    </div>
  `.trim()
}

export const buildBuyerDecisionEmail = (
  request: PurchaseRequestEmailData,
  finalRequestUrl?: string | null
) => {
  const approved = request.status === "ready_to_purchase"
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const confirmedTotal = getConfirmedItemsTotal(request)

  const firstLine = approved
    ? `${PURCHASE_BUYER_NAME} - demande d'achat #${displayRequestNumber} approuvée par ${PURCHASE_ADMIN_NAME} et prête à être achetée`
    : `Demande d'achat #${displayRequestNumber} refusée par ${PURCHASE_ADMIN_NAME}`

  return `
${firstLine}

Demandeur:
${request.requested_by || "Non indiqué"}

Courriel du demandeur:
${formatRequesterEmail(request)}

Nombre d'articles:
${items.length}

Date requise:
${formatDateFr(request.expected_date || request.needed_by_date)}

Prix total confirmé:
${confirmedTotal === null ? "Non indiqué" : formatMoney(confirmedTotal)}

Décision:
${approved ? "Approuvée pour achat" : "Refusée"}

${
  finalRequestUrl
    ? `Lien de la demande:
${finalRequestUrl}`
    : ""
}

Note de Ricardo:
${request.buyer_note || "Aucune note"}

Raison du refus:
${request.rejection_reason || "Non applicable"}

Articles:

${formatRequestItemsForEmail(items, {
  includeRequestedPrices: true,
  includeConfirmedPrices: true,
  includeProductLinks: true,
})}

${
  approved
    ? "Prochaine étape:\nRicardo doit procéder à l'achat."
    : "Prochaine étape:\nRicardo ne doit pas procéder à l'achat."
}
  `.trim()
}

export const buildBuyerDecisionEmailHtml = (
  request: PurchaseRequestEmailData,
  finalRequestUrl?: string | null
) => {
  const approved = request.status === "ready_to_purchase"
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const confirmedTotal = getConfirmedItemsTotal(request)

  const firstLine = approved
    ? `${PURCHASE_BUYER_NAME} - demande d'achat #${displayRequestNumber} approuvée par ${PURCHASE_ADMIN_NAME} et prête à être achetée`
    : `Demande d'achat #${displayRequestNumber} refusée par ${PURCHASE_ADMIN_NAME}`

  const safeFinalRequestUrl = finalRequestUrl
    ? escapeHtml(finalRequestUrl)
    : ""

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <h1 style="font-size:24px;line-height:1.2;margin:0 0 18px;">
        ${escapeHtml(firstLine)}
      </h1>

      <p><strong>Demandeur:</strong><br />${escapeHtml(
        request.requested_by || "Non indiqué"
      )}</p>

      <p><strong>Courriel du demandeur:</strong><br />${escapeHtml(
        formatRequesterEmail(request)
      )}</p>

      <p><strong>Nombre d'articles:</strong><br />${items.length}</p>

      <p><strong>Date requise:</strong><br />${formatDateFr(
        request.expected_date || request.needed_by_date
      )}</p>

      <p><strong>Prix total confirmé:</strong><br />${
        confirmedTotal === null ? "Non indiqué" : formatMoney(confirmedTotal)
      }</p>

      <p><strong>Décision:</strong><br />${
        approved ? "Approuvée pour achat" : "Refusée"
      }</p>

      ${
        safeFinalRequestUrl
          ? `
            <p>
              <a
                href="${safeFinalRequestUrl}"
                target="_blank"
                rel="noopener noreferrer"
                style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;font-weight:700;"
              >
                Ricardo - Rappel de la demande
              </a>
            </p>

            <p style="color:#475569;font-size:13px;">
              Lien direct:<br />
              <a href="${safeFinalRequestUrl}" target="_blank" rel="noopener noreferrer">
                ${safeFinalRequestUrl}
              </a>
            </p>
          `
          : ""
      }

      <p><strong>Note de Ricardo:</strong><br />${escapeHtml(
        request.buyer_note || "Aucune note"
      )}</p>

      <p><strong>Raison du refus:</strong><br />${escapeHtml(
        request.rejection_reason || "Non applicable"
      )}</p>

      <h3>Articles</h3>

      ${formatRequestItemsForEmailHtml(items, {
        includeRequestedPrices: true,
        includeConfirmedPrices: true,
        includeProductLinks: true,
      })}

      <p><strong>Prochaine étape:</strong><br />
        ${
          approved
            ? "Ricardo doit procéder à l'achat."
            : "Ricardo ne doit pas procéder à l'achat."
        }
      </p>
    </div>
  `.trim()
}

export const buildRequesterDecisionEmail = (
  request: PurchaseRequestEmailData
) => {
  const approved = request.status === "ready_to_purchase"
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)

  return `
Bonjour${request.requested_by ? ` ${request.requested_by}` : ""},

Votre demande d'achat #${displayRequestNumber} a été ${
    approved ? "approuvée" : "refusée"
  } par ${PURCHASE_ADMIN_NAME}.

Statut:
${approved ? "Approuvée pour achat" : "Refusée"}

Date requise:
${formatDateFr(request.expected_date || request.needed_by_date)}

${
  approved
    ? "Prochaine étape:\nLa demande est maintenant entre les mains de Ricardo pour l'achat."
    : `Raison du refus:\n${request.rejection_reason || "Aucune raison indiquée"}`
}

Articles:

${formatRequestItemsForEmail(items, {
  includeRequestedPrices: true,
  includeConfirmedPrices: true,
  includeProductLinks: true,
})}

Merci,
Vegibec
  `.trim()
}

export const buildRequesterDecisionEmailHtml = (
  request: PurchaseRequestEmailData
) => {
  const approved = request.status === "ready_to_purchase"
  const items = getEmailItems(request)

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <p>Bonjour${
        request.requested_by ? ` ${escapeHtml(request.requested_by)}` : ""
      },</p>

      <p>
        Votre demande d'achat #${escapeHtml(
          getPurchaseRequestDisplayNumber(request)
        )} a ete ${approved ? "approuvee" : "refusee"} par ${escapeHtml(
          PURCHASE_ADMIN_NAME
        )}.
      </p>

      <p><strong>Statut:</strong><br />${
        approved ? "Approuvee pour achat" : "Refusee"
      }</p>

      <p><strong>Date requise:</strong><br />${formatDateFr(
        request.expected_date || request.needed_by_date
      )}</p>

      ${
        approved
          ? `
            <p><strong>Prochaine etape:</strong><br />
              La demande est maintenant entre les mains de Ricardo pour l'achat.
            </p>
          `
          : `
            <p><strong>Raison du refus:</strong><br />${escapeHtml(
              request.rejection_reason || "Aucune raison indiquee"
            )}</p>
          `
      }

      <h3>Articles</h3>

      ${formatRequestItemsForEmailHtml(items, {
        includeRequestedPrices: true,
        includeConfirmedPrices: true,
        includeProductLinks: true,
      })}

      <p>Merci,<br />Vegibec</p>
    </div>
  `.trim()
}

const getDirectApprovalApprover = (request: PurchaseRequestEmailData) => {
  return typeof request.direct_approval_approver === "string" &&
    request.direct_approval_approver.trim()
    ? request.direct_approval_approver.trim()
    : "Non indiqué"
}

export const buildDirectApprovalBuyerDecisionEmail = (
  request: PurchaseRequestEmailData,
  finalRequestUrl?: string | null
) => {
  const approver = getDirectApprovalApprover(request)

  return `
IMPORTANT - APPROBATION DIRECTE

Cette demande d'achat a été approuvée directement par ${approver}.
Elle coutourne l'approbation de ${PURCHASE_ADMIN_NAME} et peut maintenant être achetée.

${buildBuyerDecisionEmail(request, finalRequestUrl)}
  `.trim()
}

export const buildDirectApprovalBuyerDecisionEmailHtml = (
  request: PurchaseRequestEmailData,
  finalRequestUrl?: string | null
) => {
  const approver = getDirectApprovalApprover(request)

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <div style="background:#dc2626;color:#ffffff;padding:16px 18px;border-radius:6px;margin:0 0 18px;font-size:18px;font-weight:800;text-transform:uppercase;">
        APPROBATION DIRECTE - approuvée par ${escapeHtml(approver)}
      </div>

      <p style="color:#b91c1c;font-weight:700;font-size:16px;">
        Cette demande a été approuvée directement par ${escapeHtml(approver)} et peut maintenant être achetée.
      </p>

      ${buildBuyerDecisionEmailHtml(request, finalRequestUrl)}
    </div>
  `.trim()
}

export const buildRequesterDateChangedEmail = (
  request: PurchaseRequestEmailData
) => {
  const originalDate = formatDateFr(request.needed_by_date)
  const expectedDate = formatDateFr(request.expected_date || request.needed_by_date)
  const items = getEmailItems(request)

  return `
Bonjour${request.requested_by ? ` ${request.requested_by}` : ""},

La date demandée pour cette demande d'achat ne pourra pas être respectée.

Numéro de demande:
#${getPurchaseRequestDisplayNumber(request)}

Date demandée initialement:
${originalDate}

Nouvelle date prévue:
${expectedDate}

Articles:

${formatRequestItemsForEmail(items, {
  includeRequestedPrices: false,
  includeConfirmedPrices: false,
  includeProductLinks: false,
})}

Si cette nouvelle date pose un problème, veuillez communiquer avec Ricardo ou Michelle.

Merci,
Vegibec
  `.trim()
}

export const buildRequesterDateChangedEmailHtml = (
  request: PurchaseRequestEmailData
) => {
  const items = getEmailItems(request)

  return `
    <div style="font-family: Arial, sans-serif; color: #1f2933; line-height: 1.5;">
      <p>Bonjour${
        request.requested_by ? ` ${escapeHtml(request.requested_by)}` : ""
      },</p>

      <p>
        La date demandée pour cette demande d'achat ne pourra pas être respectée.
      </p>

      <p><strong>Numéro de demande:</strong><br />#${escapeHtml(
        getPurchaseRequestDisplayNumber(request)
      )}</p>

      <p><strong>Date demandée initialement:</strong><br />${formatDateFr(
        request.needed_by_date
      )}</p>

      <p><strong>Nouvelle date prévue:</strong><br />${formatDateFr(
        request.expected_date || request.needed_by_date
      )}</p>

      <h3>Articles</h3>

      ${formatRequestItemsForEmailHtml(items, {
        includeRequestedPrices: true,
        includeConfirmedPrices: true,
        includeProductLinks: true,
      })}

      <p>
        Si cette nouvelle date pose un problème, veuillez communiquer avec
        Ricardo ou Michelle.
        La réponse à ce courriel est dirigée vers leurs deux boîtes courriel.
      </p>

      <p>Merci,<br />Vegibec</p>
    </div>
  `.trim()
}

export const buildPurchaseRequestModifiedEmail = (
  request: PurchaseRequestEmailData
) => {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const requestedTotal = getRequestedItemsTotal(request)

  return `
La demande d'achat #${displayRequestNumber} a ete modifiee par le demandeur.

Demandeur:
${request.requested_by || "Non indique"}

Courriel du demandeur:
${formatRequesterEmail(request)}

Modifie par:
${request.modified_by_name || request.requested_by || "Non indique"}

Courriel de modification:
${request.modified_by_email || formatRequesterEmail(request)}

Date de modification:
${formatDateTimeFr(request.modified_at)}

Raison de la modification:
${request.modification_reason || "Aucune raison indiquee"}

Statut actuel:
${getPurchaseRequestStatusLabel(request.status)}

Date requise:
${formatDateFr(request.expected_date || request.needed_by_date)}

Nombre d'articles:
${items.length}

Total estime de la demande:
${requestedTotal === null ? "Non indique" : formatMoney(requestedTotal)}

Articles mis a jour:

${formatRequestItemsForEmail(items, {
  includeRequestedPrices: true,
  includeConfirmedPrices: true,
  includeProductLinks: true,
})}

Prochaine etape:
Ricardo doit revoir la demande modifiee avant de poursuivre le processus d'achat.
  `.trim()
}

export const buildPurchaseRequestModifiedEmailHtml = (
  request: PurchaseRequestEmailData
) => {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const requestedTotal = getRequestedItemsTotal(request)

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <h1 style="font-size:24px;line-height:1.2;margin:0 0 18px;">
        Demande d'achat #${escapeHtml(displayRequestNumber)} modifiee
      </h1>

      <div style="border:1px solid #bfdbfe;background:#eff6ff;color:#1e3a8a;padding:12px 14px;border-radius:6px;margin:14px 0;">
        <strong>Action requise:</strong> Ricardo doit revoir la demande modifiee avant de poursuivre le processus d'achat.
      </div>

      <p><strong>Demandeur:</strong><br />${escapeHtml(
        request.requested_by || "Non indique"
      )}</p>

      <p><strong>Courriel du demandeur:</strong><br />${escapeHtml(
        formatRequesterEmail(request)
      )}</p>

      <p><strong>Modifie par:</strong><br />${escapeHtml(
        request.modified_by_name || request.requested_by || "Non indique"
      )}</p>

      <p><strong>Courriel de modification:</strong><br />${escapeHtml(
        request.modified_by_email || formatRequesterEmail(request)
      )}</p>

      <p><strong>Date de modification:</strong><br />${formatDateTimeFr(
        request.modified_at
      )}</p>

      <p><strong>Raison de la modification:</strong><br />${escapeHtml(
        request.modification_reason || "Aucune raison indiquee"
      )}</p>

      <p><strong>Statut actuel:</strong><br />${escapeHtml(
        getPurchaseRequestStatusLabel(request.status)
      )}</p>

      <p><strong>Date requise:</strong><br />${formatDateFr(
        request.expected_date || request.needed_by_date
      )}</p>

      <p><strong>Nombre d'articles:</strong><br />${items.length}</p>

      <p><strong>Total estime de la demande:</strong><br />${
        requestedTotal === null ? "Non indique" : formatMoney(requestedTotal)
      }</p>

      <h3>Articles mis a jour</h3>

      ${formatRequestItemsForEmailHtml(items, {
        includeRequestedPrices: true,
        includeConfirmedPrices: true,
        includeProductLinks: true,
      })}
    </div>
  `.trim()
}

export const buildPurchaseRequestCancelledEmail = (
  request: PurchaseRequestEmailData
) => {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const cancellationReason =
    request.cancellation_reason || request.rejection_reason || "Aucune raison indiquee"

  return `
La demande d'achat #${displayRequestNumber} a ete annulee.

Demandeur:
${request.requested_by || "Non indique"}

Courriel du demandeur:
${formatRequesterEmail(request)}

Annulee par:
${request.cancelled_by_name || request.requested_by || "Non indique"}

Courriel d'annulation:
${request.cancelled_by_email || formatRequesterEmail(request)}

Date d'annulation:
${formatDateTimeFr(request.cancelled_at)}

Raison de l'annulation:
${cancellationReason}

Statut:
${getPurchaseRequestStatusLabel(request.status)}

Date requise:
${formatDateFr(request.expected_date || request.needed_by_date)}

Articles annules:

${formatRequestItemsForEmail(items, {
  includeRequestedPrices: true,
  includeConfirmedPrices: true,
  includeProductLinks: true,
})}

Prochaine etape:
Aucun achat ne doit etre fait pour cette demande.
  `.trim()
}

export const buildPurchaseRequestCancelledEmailHtml = (
  request: PurchaseRequestEmailData
) => {
  const displayRequestNumber = getPurchaseRequestDisplayNumber(request)
  const items = getEmailItems(request)
  const cancellationReason =
    request.cancellation_reason || request.rejection_reason || "Aucune raison indiquee"

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <h1 style="font-size:24px;line-height:1.2;margin:0 0 18px;">
        Demande d'achat #${escapeHtml(displayRequestNumber)} annulee
      </h1>

      <div style="border:1px solid #fecaca;background:#fef2f2;color:#991b1b;padding:12px 14px;border-radius:6px;margin:14px 0;">
        <strong>Aucun achat ne doit etre fait pour cette demande.</strong>
      </div>

      <p><strong>Demandeur:</strong><br />${escapeHtml(
        request.requested_by || "Non indique"
      )}</p>

      <p><strong>Courriel du demandeur:</strong><br />${escapeHtml(
        formatRequesterEmail(request)
      )}</p>

      <p><strong>Annulee par:</strong><br />${escapeHtml(
        request.cancelled_by_name || request.requested_by || "Non indique"
      )}</p>

      <p><strong>Courriel d'annulation:</strong><br />${escapeHtml(
        request.cancelled_by_email || formatRequesterEmail(request)
      )}</p>

      <p><strong>Date d'annulation:</strong><br />${formatDateTimeFr(
        request.cancelled_at
      )}</p>

      <p><strong>Raison de l'annulation:</strong><br />${escapeHtml(
        cancellationReason
      )}</p>

      <p><strong>Statut:</strong><br />${escapeHtml(
        getPurchaseRequestStatusLabel(request.status)
      )}</p>

      <p><strong>Date requise:</strong><br />${formatDateFr(
        request.expected_date || request.needed_by_date
      )}</p>

      <h3>Articles annules</h3>

      ${formatRequestItemsForEmailHtml(items, {
        includeRequestedPrices: true,
        includeConfirmedPrices: true,
        includeProductLinks: true,
      })}
    </div>
  `.trim()
}

export const sendPurchaseRequestEmailSafely = async (
  to: string | string[],
  subject: string,
  text: string,
  html?: string,
  replyTo?: string | string[]
) => {
  if (!to) return

  try {
    const emailInfo = await sendEmail({
      to,
      fromLabel: "Vegibec - Demandes d'achat",
      subject,
      text,
      html,
      replyTo,
    })

    console.log("Purchase request email relay response:", {
      to,
      subject,
      replyTo,
      messageId: emailInfo.messageId,
      accepted: emailInfo.accepted,
      rejected: emailInfo.rejected,
      response: emailInfo.response,
    })
  } catch (error) {
    console.error("Purchase request email failed:", error)
  }
}

export const buildPictureEmailLinks = async (
  pictureKeys: string[],
  pictures: Express.Multer.File[]
): Promise<PictureEmailLink[]> => {
  return Promise.all(
    pictureKeys.map(async (pictureKey, index) => ({
      label: pictures[index]?.originalname || "",
      url: await getSignedUrlForKey(pictureKey, {
        expiresIn: PURCHASE_REQUEST_PICTURE_URL_EXPIRES_IN_SECONDS,
      }),
    }))
  )
}
