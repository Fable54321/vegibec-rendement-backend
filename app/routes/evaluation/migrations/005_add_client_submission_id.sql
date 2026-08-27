BEGIN;

ALTER TABLE evaluation.evaluations
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS evaluations_client_submission_id_uidx
  ON evaluation.evaluations (client_submission_id)
  WHERE client_submission_id IS NOT NULL;

COMMENT ON COLUMN evaluation.evaluations.client_submission_id IS
  'Client-generated UUID used to make online and offline submission retries idempotent.';

COMMIT;
