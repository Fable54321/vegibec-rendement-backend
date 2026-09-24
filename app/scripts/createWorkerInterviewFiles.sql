CREATE TABLE IF NOT EXISTS foreign_workers_schedule.worker_interview_files (
  id BIGSERIAL PRIMARY KEY,
  interview_id INTEGER NOT NULL
    REFERENCES foreign_workers_schedule.worker_interviews(id)
    ON DELETE CASCADE,
  file_key TEXT NOT NULL UNIQUE,
  original_file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS worker_interview_files_interview_id_idx
  ON foreign_workers_schedule.worker_interview_files(interview_id);

INSERT INTO foreign_workers_schedule.worker_interview_files (
  interview_id,
  file_key,
  original_file_name
)
SELECT
  id,
  file_key,
  COALESCE(original_file_name, 'document')
FROM foreign_workers_schedule.worker_interviews
WHERE file_key IS NOT NULL
ON CONFLICT (file_key) DO NOTHING;
