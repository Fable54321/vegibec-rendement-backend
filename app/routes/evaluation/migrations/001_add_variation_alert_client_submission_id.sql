ALTER TABLE evaluation.performance_variation_alerts
  ADD COLUMN IF NOT EXISTS client_submission_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS performance_variation_alerts_client_submission_id_uidx
  ON evaluation.performance_variation_alerts (client_submission_id);
