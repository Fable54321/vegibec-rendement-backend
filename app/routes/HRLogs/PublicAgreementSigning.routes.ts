import crypto from "crypto"
import { Router, type NextFunction, type Request, type Response } from "express"
import rateLimit from "express-rate-limit"
import multer from "multer"

import { pool } from "../../db"
import {
  deleteObjectFromS3,
  uploadBufferToS3,
} from "../../services/s3.services"
import {
  ensureAgreementSigningSessionTable,
  hashAgreementSigningToken,
  readAgreementSigningToken,
} from "./agreementSigningSessions"

const router = Router()

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 400,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Trop de demandes. Veuillez réessayer plus tard." },
})

const signLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    message: "Trop de tentatives de signature. Veuillez réessayer plus tard.",
  },
})

const signatureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"])

    if (!allowedTypes.has(file.mimetype)) {
      callback(new Error("INVALID_SIGNATURE_TYPE"))
      return
    }

    callback(null, true)
  },
})

const signatureKey = (
  workerUserId: string,
  interviewId: string,
  mimeType: string,
) => {
  const extension =
    mimeType === "image/jpeg"
      ? ".jpg"
      : mimeType === "image/webp"
        ? ".webp"
        : ".png"

  return `worker-interview-agreements/${workerUserId}/${interviewId}/${crypto
    .randomBytes(16)
    .toString("hex")}${extension}`
}

const requireSigningToken = (
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  const token = readAgreementSigningToken(request.get("authorization"))

  if (!token) {
    response.status(401).json({ message: "Session de signature invalide" })
    return
  }

  response.locals.signingTokenHash = hashAgreementSigningToken(token)
  next()
}

router.use((_request, response, next) => {
  response.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  })
  next()
})

router.get("/session", readLimiter, requireSigningToken, async (_req, res) => {
  try {
    await ensureAgreementSigningSessionTable()

    const result = await pool.query(
      `
      SELECT
        session.expires_at,
        session.expires_at <= NOW() AS expired,
        session.used_at,
        session.revoked_at,
        agreement.status,
        agreement.agreement_terms,
        CONCAT(
          COALESCE(worker.surname, ''),
          ' ',
          COALESCE(worker.name, '')
        ) AS worker_name
      FROM foreign_workers_schedule.worker_interview_agreement_signing_sessions session
      JOIN foreign_workers_schedule.worker_interview_agreements agreement
        ON agreement.id = session.agreement_id
      JOIN foreign_workers_schedule.worker_interviews interview
        ON interview.id = agreement.interview_id
      LEFT JOIN public.users worker
        ON worker.id = interview.worker_user_id
      WHERE session.token_hash = $1
        AND interview.deleted_at IS NULL
      LIMIT 1
      `,
      [res.locals.signingTokenHash],
    )

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Session de signature invalide" })
    }

    const session = result.rows[0]
    const unavailable =
      session.used_at ||
      session.revoked_at ||
      session.status === "signed" ||
      session.expired

    if (unavailable) {
      return res.status(410).json({
        message: "Cette session de signature a expiré ou a déjà été utilisée",
      })
    }

    return res.json({
      worker_name: session.worker_name?.trim() || null,
      agreement_terms: session.agreement_terms,
      expires_at: session.expires_at,
    })
  } catch (error) {
    console.error("Error loading public agreement signing session:", error)
    return res.status(500).json({
      message: "Erreur lors du chargement de l'entente",
    })
  }
})

router.post(
  "/session/sign",
  signLimiter,
  requireSigningToken,
  signatureUpload.single("signature"),
  async (req, res) => {
    const hasAcceptedTerms =
      req.body.has_accepted_terms === true ||
      req.body.has_accepted_terms === "true"

    if (!hasAcceptedTerms) {
      return res.status(400).json({
        message: "Les termes de l'entente doivent être acceptés",
      })
    }

    if (!req.file) {
      return res.status(400).json({ message: "La signature est requise" })
    }

    await ensureAgreementSigningSessionTable()

    const client = await pool.connect()
    let uploadedSignatureKey: string | null = null
    let committed = false

    try {
      await client.query("BEGIN")

      const result = await client.query(
        `
        SELECT
          session.id AS session_id,
          session.expires_at,
          session.expires_at <= NOW() AS expired,
          session.used_at,
          session.revoked_at,
          agreement.id AS agreement_id,
          agreement.status AS agreement_status,
          agreement.signature_s3_key,
          interview.id AS interview_id,
          interview.worker_user_id
        FROM foreign_workers_schedule.worker_interview_agreement_signing_sessions session
        JOIN foreign_workers_schedule.worker_interview_agreements agreement
          ON agreement.id = session.agreement_id
        JOIN foreign_workers_schedule.worker_interviews interview
          ON interview.id = agreement.interview_id
        WHERE session.token_hash = $1
          AND interview.deleted_at IS NULL
        FOR UPDATE OF session, agreement, interview
        `,
        [res.locals.signingTokenHash],
      )

      if (result.rowCount === 0) {
        await client.query("ROLLBACK")
        return res.status(404).json({ message: "Session de signature invalide" })
      }

      const session = result.rows[0]
      const unavailable =
        session.used_at ||
        session.revoked_at ||
        session.agreement_status === "signed" ||
        session.expired

      if (unavailable) {
        await client.query("ROLLBACK")
        return res.status(410).json({
          message: "Cette session de signature a expiré ou a déjà été utilisée",
        })
      }

      const previousSignatureKey = session.signature_s3_key as string | null
      uploadedSignatureKey = signatureKey(
        String(session.worker_user_id),
        String(session.interview_id),
        req.file.mimetype,
      )

      await uploadBufferToS3({
        key: uploadedSignatureKey,
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
      })

      const consumeResult = await client.query(
        `
        UPDATE foreign_workers_schedule.worker_interview_agreement_signing_sessions
        SET used_at = NOW()
        WHERE id = $1
          AND used_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > NOW()
        RETURNING id
        `,
        [session.session_id],
      )

      if (consumeResult.rowCount === 0) {
        await client.query("ROLLBACK")
        await deleteObjectFromS3(uploadedSignatureKey).catch(() => undefined)
        uploadedSignatureKey = null

        return res.status(410).json({
          message: "Cette session de signature a expiré ou a déjà été utilisée",
        })
      }

      const agreementResult = await client.query(
        `
        UPDATE foreign_workers_schedule.worker_interview_agreements
        SET
          status = 'signed',
          signature_s3_key = $1,
          has_accepted_terms = TRUE,
          signed_at = NOW(),
          updated_at = NOW()
        WHERE id = $2
          AND status = 'pending_signature'
        RETURNING signed_at
        `,
        [uploadedSignatureKey, session.agreement_id],
      )

      if (agreementResult.rowCount === 0) {
        throw new Error("Agreement was no longer available for signing")
      }

      await client.query(
        `
        UPDATE foreign_workers_schedule.worker_interview_agreement_signing_sessions
        SET revoked_at = NOW()
        WHERE agreement_id = $1
          AND id <> $2
          AND used_at IS NULL
          AND revoked_at IS NULL
        `,
        [session.agreement_id, session.session_id],
      )

      await client.query("COMMIT")
      committed = true

      if (
        previousSignatureKey &&
        previousSignatureKey !== uploadedSignatureKey
      ) {
        await deleteObjectFromS3(previousSignatureKey).catch((cleanupError) =>
          console.error("Error deleting replaced agreement signature:", cleanupError),
        )
      }

      return res.json({
        message: "Entente signée avec succès",
        status: "signed",
        signed_at: agreementResult.rows[0].signed_at,
      })
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK").catch(() => undefined)

        if (uploadedSignatureKey) {
          await deleteObjectFromS3(uploadedSignatureKey).catch((cleanupError) =>
            console.error("Error cleaning up agreement signature:", cleanupError),
          )
        }
      }

      console.error("Error signing agreement with public session:", error)
      return res.status(500).json({
        message: "Erreur lors de la signature de l'entente",
      })
    } finally {
      client.release()
    }
  },
)

router.use(
  (
    error: Error | multer.MulterError,
    _request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      response.status(413).json({
        message: "La signature dépasse la taille maximale autorisée",
      })
      return
    }

    if (error.message === "INVALID_SIGNATURE_TYPE") {
      response.status(415).json({
        message: "Le fichier de signature doit être une image PNG, JPEG ou WebP",
      })
      return
    }

    next(error)
  },
)

export default router
