import { pool } from "../../db"

let agreementSignatureSchemaPromise: Promise<void> | null = null

export const ensureAgreementSignatureSchema = async () => {
  if (agreementSignatureSchemaPromise) return agreementSignatureSchemaPromise

  agreementSignatureSchemaPromise = pool
    .query(`
      ALTER TABLE foreign_workers_schedule.worker_interview_agreements
        ADD COLUMN IF NOT EXISTS hr_signature_s3_key TEXT,
        ADD COLUMN IF NOT EXISTS hr_signed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS hr_signer_user_id INTEGER
          REFERENCES public.users(id);
    `)
    .then(() => undefined)
    .catch((error) => {
      agreementSignatureSchemaPromise = null
      throw error
    })

  return agreementSignatureSchemaPromise
}
