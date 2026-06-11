import crypto from "crypto"
import type { Request } from "express"
import multer from "multer"
import path from "path"
import type { PoolClient } from "pg"
import { getSignedUrlForKey } from "../../../services/s3.services"
import { sendEmail } from "../../Visitors/Utils/testSMTP"

const BUYER_VALIDATION_TOKEN_EXPIRES_IN_DAYS = 14
const ADMIN_APPROVAL_TOKEN_EXPIRES_IN_DAYS = 14
const PURCHASE_REQUEST_PICTURE_URL_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7

export type PictureEmailLink = {
  label: string
  url: string
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

export const uploadPurchaseRequestPictures = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 5,
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
    .map((name) => process.env[name]?.trim())
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
      token,
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
      AND token = $2
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
      AND token = $2
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
  const configuredBaseUrl = "http://localhost:5173"

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
  const configuredBaseUrl = "http://localhost:5173"
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
  purchaseRequestId: number
) => {
  const configuredBaseUrl = "http://localhost:5173"
  const baseUrl =
    configuredBaseUrl ||
    (process.env.NODE_ENV === "production"
      ? "https://achats.vegibec-portail.com"
      : `${req.protocol}://${req.get("host") || "localhost:3000"}`)

  return `${baseUrl.replace(/\/$/, "")}/requete/${purchaseRequestId}`
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

const formatRequesterEmail = (request: any) => {
  return typeof request.request_email === "string" && request.request_email.trim()
    ? request.request_email.trim()
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
  request: any,
  pictureLinks: PictureEmailLink[] = [],
  buyerValidationUrl: string
) => {
  const pictureExpiryText =
    pictureLinks.length > 0 ? "\n\nLes liens des photos expirent dans 7 jours." : ""

  return `
Une nouvelle demande d'achat a été créée.

Numéro de demande: #${request.id}

Demandeur:
${request.requested_by}

Courriel du demandeur:
${formatRequesterEmail(request)}

Description:
${request.description}

Quantité:
${request.quantity}

Prix unitaire estimé:
${formatMoney(request.requested_unit_price)}

Prix total estimé:
${formatMoney(request.requested_total_price)}

Lien produit:
${request.product_link || "Aucun lien indiqué"}

Date requise:
${formatDateFr(request.expected_date)}

Urgence:
${request.urgency || "Normal"}

Photos:
${formatPictureLinksForEmail(pictureLinks)}${pictureExpiryText}

Lien de validation acheteur:
${buyerValidationUrl}

Justification:
${request.reason || "Aucune justification indiquée"}

Prochaine étape:
L'acheteur doit confirmer le prix avec le lien de validation.
  `.trim()
}

export const buildNewPurchaseRequestEmailHtml = (
  request: any,
  pictureLinks: PictureEmailLink[] = [],
  buyerValidationUrl: string
) => {
  const productLinkUrl = getSafeHttpUrl(request.product_link)
  const safeBuyerValidationUrl = escapeHtml(buyerValidationUrl)

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <h2>Nouvelle demande d'achat #${escapeHtml(request.id)}</h2>

      <p>Une nouvelle demande d'achat a été créée.</p>

      <p><strong>Demandeur:</strong><br />${escapeHtml(request.requested_by)}</p>
      <p><strong>Courriel du demandeur:</strong><br />${escapeHtml(
        formatRequesterEmail(request)
      )}</p>

      <p><strong>Description:</strong><br />${escapeHtml(request.description)}</p>

      <p><strong>Quantité:</strong><br />${escapeHtml(request.quantity)}</p>

      <p><strong>Prix unitaire estimé:</strong><br />${formatMoney(
        request.requested_unit_price
      )}</p>

      <p><strong>Prix total estimé:</strong><br />${formatMoney(
        request.requested_total_price
      )}</p>

      <p>
        <strong>Lien produit:</strong><br />
        ${
          productLinkUrl
            ? `<a href="${escapeHtml(
                productLinkUrl
              )}" target="_blank" rel="noopener noreferrer">Voir le produit</a>`
            : "Aucun lien indiqué"
        }
      </p>

      <p><strong>Date requise:</strong><br />${formatDateFr(
        request.expected_date
      )}</p>

      <p><strong>Urgence:</strong><br />${escapeHtml(request.urgency || "Normal")}</p>

      <p><strong>Photos:</strong></p>
      ${formatPictureLinksForEmailHtml(pictureLinks)}

      <p>
        <a
          href="${safeBuyerValidationUrl}"
          target="_blank"
          rel="noopener noreferrer"
          style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;font-weight:700;"
        >
          Confirmer le prix
        </a>
      </p>

      <p style="color:#475569;font-size:13px;">
        Lien direct:<br />
        <a href="${safeBuyerValidationUrl}" target="_blank" rel="noopener noreferrer">
          ${safeBuyerValidationUrl}
        </a>
      </p>

      <p><strong>Justification:</strong><br />${
        request.reason ? escapeHtml(request.reason) : "Aucune justification indiquée"
      }</p>

      <hr />

      <p><strong>Prochaine étape:</strong><br />
      L'acheteur doit confirmer le prix avec le lien de validation.</p>
    </div>
  `.trim()
}

export const buildAdminApprovalEmail = (
  request: any,
  adminApprovalUrl: string
) => {
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
Une demande d'achat est prête pour approbation administrative.

Numéro de demande: #${request.id}

Demandeur:
${request.requested_by}

Courriel du demandeur:
${formatRequesterEmail(request)}

Description:
${request.description}

Quantité:
${request.quantity}

Prix unitaire confirmé:
${formatMoney(request.buyer_confirmed_unit_price)}

Prix total confirmé:
${formatMoney(request.buyer_confirmed_total_price)}${priceIncreaseWarning}

Fournisseur potentiel:
${request.buyer_confirmed_supplier || "Non indiqué"}

Note de l'acheteur:
${request.buyer_note || "Aucune note"}

Date requise:
${formatDateFr(request.expected_date)}

Urgence:
${request.urgency || "Normal"}

Lien d'approbation:
${adminApprovalUrl}

Prochaine étape:
Approbation ou refus par l'administration.
  `.trim()
}

export const buildAdminApprovalEmailHtml = (
  request: any,
  adminApprovalUrl: string
) => {
  const priceIncreaseInfo = getPriceIncreaseInfo(request)
  const confirmedTotalPriceStyle = priceIncreaseInfo
    ? "color:#b91c1c;font-weight:700;"
    : ""
  const safeAdminApprovalUrl = escapeHtml(adminApprovalUrl)

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <h2>Demande d'achat #${escapeHtml(request.id)} prête pour approbation</h2>

      <p>Une demande d'achat est prête pour approbation administrative.</p>

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

      <p><strong>Demandeur:</strong><br />${escapeHtml(request.requested_by)}</p>
      <p><strong>Courriel du demandeur:</strong><br />${escapeHtml(
        formatRequesterEmail(request)
      )}</p>
      <p><strong>Description:</strong><br />${escapeHtml(request.description)}</p>
      <p><strong>Quantité:</strong><br />${escapeHtml(request.quantity)}</p>
      <p><strong>Prix unitaire confirmé:</strong><br />${formatMoney(
        request.buyer_confirmed_unit_price
      )}</p>
      <p><strong>Prix total confirmé:</strong><br />
        <span style="${confirmedTotalPriceStyle}">${formatMoney(
          request.buyer_confirmed_total_price
        )}</span>
      </p>
      <p><strong>Fournisseur potentiel:</strong><br />${escapeHtml(
        request.buyer_confirmed_supplier || "Non indiqué"
      )}</p>
      <p><strong>Note de l'acheteur:</strong><br />${escapeHtml(
        request.buyer_note || "Aucune note"
      )}</p>
      <p><strong>Date requise:</strong><br />${formatDateFr(
        request.expected_date
      )}</p>
      <p><strong>Urgence:</strong><br />${escapeHtml(
        request.urgency || "Normal"
      )}</p>

      <p>
        <a
          href="${safeAdminApprovalUrl}"
          target="_blank"
          rel="noopener noreferrer"
          style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;font-weight:700;"
        >
          Ouvrir le formulaire d'approbation
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

const getPurchaseRequestStatusLabel = (status: string | null | undefined) => {
  const labels: Record<string, string> = {
    pending_buyer_validation: "En attente de validation par l'acheteur",
    needs_requester_info: "Information demandée au demandeur",
    pending_admin_approval: "En attente d'approbation administrative",
    approved: "Approuvée",
    rejected: "Refusée",
    ready_to_purchase: "Prête à acheter",
    purchased: "Achetée",
    cancelled: "Annulée",
  }

  return status ? labels[status] || status : "Non indiqué"
}

const getPriceIncreaseInfo = (request: any) => {
  const requestedTotalPrice = Number(request.requested_total_price)
  const confirmedTotalPrice = Number(request.buyer_confirmed_total_price)

  if (!Number.isFinite(requestedTotalPrice) || !Number.isFinite(confirmedTotalPrice)) {
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
  request: any,
  adminApprovalUrl: string
) => {
  const priceIncreaseInfo = getPriceIncreaseInfo(request)
  const priceIncreaseWarning = priceIncreaseInfo
    ? `

Attention:
Le prix total confirmé est plus élevé que le prix total estimé de la demande.
Écart: ${formatMoney(priceIncreaseInfo.difference)}
`
    : ""

  return `
Le prix de la demande d'achat #${request.id} a été confirmé par l'acheteur.

Résumé de la demande:

Demandeur:
${request.requested_by || "Non indiqué"}

Courriel du demandeur:
${formatRequesterEmail(request)}

Description:
${request.description || "Non indiquée"}

Raison:
${request.reason || "Aucune justification indiquée"}

Quantité:
${request.quantity || "Non indiquée"}

Prix total estimé dans la demande:
${formatMoney(request.requested_total_price)}

Prix unitaire confirmé:
${formatMoney(request.buyer_confirmed_unit_price)}

Prix total confirmé:
${formatMoney(request.buyer_confirmed_total_price)}${priceIncreaseWarning}

Statut:
${getPurchaseRequestStatusLabel(request.status)}

Date de validation par l'acheteur:
${formatDateTimeFr(request.buyer_validated_at)}

Date de la demande:
${formatDateTimeFr(request.requested_at || request.created_at)}

Urgence:
${request.urgency || "Normal"}

Date requise:
${formatDateFr(request.expected_at || request.expected_date)}

Lien d'approbation administrative:
${adminApprovalUrl}
  `.trim()
}

export const buildBuyerPriceConfirmedEmailHtml = (
  request: any,
  adminApprovalUrl: string
) => {
  const priceIncreaseInfo = getPriceIncreaseInfo(request)
  const confirmedTotalPriceStyle = priceIncreaseInfo
    ? "color:#b91c1c;font-weight:700;"
    : ""
  const safeAdminApprovalUrl = escapeHtml(adminApprovalUrl)

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <h2>Prix confirmé - demande d'achat #${escapeHtml(request.id)}</h2>

      <p>Le prix de la demande d'achat a été confirmé par l'acheteur.</p>

      ${
        priceIncreaseInfo
          ? `
            <div style="border:1px solid #fecaca;background:#fef2f2;color:#991b1b;padding:12px 14px;border-radius:6px;margin:14px 0;">
              <strong>Attention: prix plus élevé que la demande initiale.</strong><br />
              Écart: ${formatMoney(priceIncreaseInfo.difference)}
            </div>
          `
          : ""
      }

      <p><strong>Description:</strong><br />${escapeHtml(
        request.description || "Non indiquée"
      )}</p>

      <p><strong>Demandeur:</strong><br />${escapeHtml(
        request.requested_by || "Non indiqué"
      )}</p>

      <p><strong>Courriel du demandeur:</strong><br />${escapeHtml(
        formatRequesterEmail(request)
      )}</p>

      <p><strong>Raison:</strong><br />${escapeHtml(
        request.reason || "Aucune justification indiquée"
      )}</p>

      <p><strong>Quantité:</strong><br />${escapeHtml(
        request.quantity || "Non indiquée"
      )}</p>

      <p><strong>Prix total estimé dans la demande:</strong><br />${formatMoney(
        request.requested_total_price
      )}</p>

      <p><strong>Prix unitaire confirmé:</strong><br />${formatMoney(
        request.buyer_confirmed_unit_price
      )}</p>

      <p><strong>Prix total confirmé:</strong><br />
        <span style="${confirmedTotalPriceStyle}">${formatMoney(
          request.buyer_confirmed_total_price
        )}</span>
      </p>

      <p><strong>Statut:</strong><br />${escapeHtml(
        getPurchaseRequestStatusLabel(request.status)
      )}</p>

      <p><strong>Date de validation par l'acheteur:</strong><br />${formatDateTimeFr(
        request.buyer_validated_at
      )}</p>

      <p><strong>Date de la demande:</strong><br />${formatDateTimeFr(
        request.requested_at || request.created_at
      )}</p>

      <p><strong>Urgence:</strong><br />${escapeHtml(
        request.urgency || "Normal"
      )}</p>

      <p><strong>Date requise:</strong><br />${formatDateFr(
        request.expected_at || request.expected_date
      )}</p>

      <p>
        <a
          href="${safeAdminApprovalUrl}"
          target="_blank"
          rel="noopener noreferrer"
          style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;font-weight:700;"
        >
          Ouvrir le formulaire d'approbation
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

export const buildBuyerDecisionEmail = (request: any, finalRequestUrl: string) => {
  const approved = request.status === "ready_to_purchase"
  const firstLine = approved
    ? `${request.requested_by} demande d'achat #${request.id} approuvée et prête à être achetée`
    : `${request.requested_by} demande d'achat #${request.id} refusée`

  return `
${firstLine}

Demandeur:
${request.requested_by}

Courriel du demandeur:
${formatRequesterEmail(request)}

Description:
${request.description}

Quantité:
${request.quantity}

Date requise:
${formatDateFr(request.expected_date)}

Prix total confirmé:
${formatMoney(request.buyer_confirmed_total_price)}

Décision:
${approved ? "Approuvée pour achat" : "Refusée"}

Lien de la demande:
${finalRequestUrl}

Note de l'administration:
${request.admin_note || "Aucune note"}

Raison du refus:
${request.rejection_reason || "Non applicable"}

${
  approved
    ? "Prochaine étape:\nL'acheteur peut procéder à l'achat."
    : "Aucune action d'achat ne doit être effectuée."
}
  `.trim()
}

export const buildBuyerDecisionEmailHtml = (
  request: any,
  finalRequestUrl: string
) => {
  const approved = request.status === "ready_to_purchase"
  const firstLine = approved
    ? `${request.requested_by} demande d'achat #${request.id} approuvée et prête à être achetée`
    : `${request.requested_by} demande d'achat #${request.id} refusée`
  const safeFinalRequestUrl = escapeHtml(finalRequestUrl)

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
      <h1 style="font-size:24px;line-height:1.2;margin:0 0 18px;">
        ${escapeHtml(firstLine)}
      </h1>

      <p><strong>Demandeur:</strong><br />${escapeHtml(request.requested_by)}</p>
      <p><strong>Courriel du demandeur:</strong><br />${escapeHtml(
        formatRequesterEmail(request)
      )}</p>
      <p><strong>Description:</strong><br />${escapeHtml(request.description)}</p>
      <p><strong>Quantité:</strong><br />${escapeHtml(request.quantity)}</p>
      <p><strong>Date requise:</strong><br />${formatDateFr(request.expected_date)}</p>
      <p><strong>Prix total confirmé:</strong><br />${formatMoney(
        request.buyer_confirmed_total_price
      )}</p>
      <p><strong>Décision:</strong><br />${
        approved ? "Approuvée pour achat" : "Refusée"
      }</p>

      <p>
        <a
          href="${safeFinalRequestUrl}"
          target="_blank"
          rel="noopener noreferrer"
          style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:6px;font-weight:700;"
        >
          Ouvrir la demande
        </a>
      </p>

      <p style="color:#475569;font-size:13px;">
        Lien direct:<br />
        <a href="${safeFinalRequestUrl}" target="_blank" rel="noopener noreferrer">
          ${safeFinalRequestUrl}
        </a>
      </p>

      <p><strong>Note de l'administration:</strong><br />${escapeHtml(
        request.admin_note || "Aucune note"
      )}</p>
      <p><strong>Raison du refus:</strong><br />${escapeHtml(
        request.rejection_reason || "Non applicable"
      )}</p>
    </div>
  `.trim()
}

export const sendPurchaseRequestEmailSafely = async (
  to: string,
  subject: string,
  text: string,
  html?: string
) => {
  if (!to) return

  try {
    await sendEmail({
      to,
      fromLabel: "Vegibec - Demandes d'achat",
      subject,
      text,
      html,
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
