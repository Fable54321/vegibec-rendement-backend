import crypto from "crypto"
import type { PoolClient } from "pg"

import { pool } from "../../db"

const SESSION_LIFETIME_MINUTES = 10

let signingSessionTablePromise: Promise<void> | null = null

export const ensureAgreementSigningSessionTable = async () => {
  if (signingSessionTablePromise) return signingSessionTablePromise

  signingSessionTablePromise = pool
    .query(`
      CREATE TABLE IF NOT EXISTS foreign_workers_schedule.worker_interview_agreement_signing_sessions (
        id BIGSERIAL PRIMARY KEY,
        agreement_id BIGINT NOT NULL
          REFERENCES foreign_workers_schedule.worker_interview_agreements(id)
          ON DELETE CASCADE,
        created_by_user_id INTEGER NOT NULL REFERENCES public.users(id),
        token_hash CHAR(64) NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS worker_interview_agreement_signing_sessions_agreement_idx
        ON foreign_workers_schedule.worker_interview_agreement_signing_sessions
        (agreement_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS worker_interview_agreement_signing_sessions_expiry_idx
        ON foreign_workers_schedule.worker_interview_agreement_signing_sessions
        (expires_at);
    `)
    .then(() => undefined)
    .catch((error) => {
      signingSessionTablePromise = null
      throw error
    })

  return signingSessionTablePromise
}

export const hashAgreementSigningToken = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex")

export const readAgreementSigningToken = (authorization?: string) => {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)
  return match?.[1] ?? null
}

export type AgreementSigningSessionResult = {
  token: string
  expires_at: string
}

export class AgreementSigningSessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const findAccessibleAgreement = async (
  client: PoolClient,
  interviewId: number,
  userId: number,
) => {
  const result = await client.query(
    `
    SELECT agreement.id, agreement.status
    FROM foreign_workers_schedule.worker_interviews wi
    JOIN foreign_workers_schedule.worker_interview_agreements agreement
      ON agreement.interview_id = wi.id
    WHERE wi.id = $1
      AND wi.deleted_at IS NULL
      AND wi.needs_agreement = TRUE
      AND (
        wi.status = 'completed'
        OR (wi.status = 'draft' AND wi.hr_user_id = $2)
      )
    FOR UPDATE OF wi, agreement
    `,
    [interviewId, userId],
  )

  if (result.rowCount === 0) {
    throw new AgreementSigningSessionError("Entente introuvable", 404)
  }

  return result.rows[0] as { id: number; status: string }
}

export const createAgreementSigningSession = async (
  interviewId: number,
  userId: number,
): Promise<AgreementSigningSessionResult> => {
  await ensureAgreementSigningSessionTable()

  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    const agreement = await findAccessibleAgreement(
      client,
      interviewId,
      userId,
    )

    if (agreement.status === "signed") {
      throw new AgreementSigningSessionError(
        "Cette entente est déjà signée",
        409,
      )
    }

    await client.query(
      `
      UPDATE foreign_workers_schedule.worker_interview_agreement_signing_sessions
      SET revoked_at = NOW()
      WHERE agreement_id = $1
        AND used_at IS NULL
        AND revoked_at IS NULL
      `,
      [agreement.id],
    )

    const token = crypto.randomBytes(32).toString("base64url")
    const result = await client.query(
      `
      INSERT INTO foreign_workers_schedule.worker_interview_agreement_signing_sessions (
        agreement_id,
        created_by_user_id,
        token_hash,
        expires_at
      )
      VALUES ($1, $2, $3, NOW() + ($4::text || ' minutes')::interval)
      RETURNING expires_at
      `,
      [
        agreement.id,
        userId,
        hashAgreementSigningToken(token),
        SESSION_LIFETIME_MINUTES,
      ],
    )

    await client.query("COMMIT")

    return {
      token,
      expires_at: result.rows[0].expires_at,
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export const revokeAgreementSigningSessions = async (
  interviewId: number,
  userId: number,
) => {
  await ensureAgreementSigningSessionTable()

  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    const agreement = await findAccessibleAgreement(
      client,
      interviewId,
      userId,
    )

    await client.query(
      `
      UPDATE foreign_workers_schedule.worker_interview_agreement_signing_sessions
      SET revoked_at = NOW()
      WHERE agreement_id = $1
        AND used_at IS NULL
        AND revoked_at IS NULL
      `,
      [agreement.id],
    )

    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
