BEGIN;

CREATE TABLE IF NOT EXISTS timesheets.user_overtime_weeks (
  user_id integer NOT NULL,
  week_start date NOT NULL,
  total_minutes bigint NOT NULL DEFAULT 0,
  banked_minutes bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, week_start)
);

CREATE INDEX IF NOT EXISTS user_overtime_weeks_week_start_idx
  ON timesheets.user_overtime_weeks (week_start);

CREATE TABLE IF NOT EXISTS timesheets.user_overtime_totals (
  user_id integer PRIMARY KEY,
  total_banked_minutes bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION timesheets.refresh_user_overtime_total(
  target_user_id integer
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  calculated_total bigint;
BEGIN
  SELECT COALESCE(SUM(ow.banked_minutes), 0)::bigint
  INTO calculated_total
  FROM timesheets.user_overtime_weeks ow
  WHERE ow.user_id = target_user_id;

  INSERT INTO timesheets.user_overtime_totals (
    user_id,
    total_banked_minutes,
    updated_at
  )
  VALUES (target_user_id, calculated_total, NOW())
  ON CONFLICT (user_id)
  DO UPDATE SET
    total_banked_minutes = EXCLUDED.total_banked_minutes,
    updated_at = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION timesheets.refresh_user_overtime_week(
  target_user_id integer,
  target_week_start date
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  calculated_total bigint;
BEGIN
  SELECT
    GREATEST(
      0,
      SUM(
        COALESCE(
          ws.duration_minutes,
          ROUND(EXTRACT(EPOCH FROM ws.end_time - ws.start_time) / 60)
        )
      ) - SUM(COALESCE(ws.lunch_duration, 0))
    )::bigint
  INTO calculated_total
  FROM timesheets.work_sessions ws
  WHERE ws.user_id = target_user_id
    AND ws.end_time IS NOT NULL
    AND date_trunc(
      'week',
      ws.start_time AT TIME ZONE 'America/Toronto'
    )::date = target_week_start;

  IF calculated_total IS NULL THEN
    DELETE FROM timesheets.user_overtime_weeks
    WHERE user_id = target_user_id
      AND week_start = target_week_start;
    PERFORM timesheets.refresh_user_overtime_total(target_user_id);
    RETURN;
  END IF;

  INSERT INTO timesheets.user_overtime_weeks (
    user_id,
    week_start,
    total_minutes,
    banked_minutes,
    updated_at
  )
  VALUES (
    target_user_id,
    target_week_start,
    calculated_total,
    GREATEST(0, calculated_total - 2400),
    NOW()
  )
  ON CONFLICT (user_id, week_start)
  DO UPDATE SET
    total_minutes = EXCLUDED.total_minutes,
    banked_minutes = EXCLUDED.banked_minutes,
    updated_at = NOW();

  PERFORM timesheets.refresh_user_overtime_total(target_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION timesheets.sync_user_overtime_week()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_week_start date;
  new_week_start date;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_week_start := date_trunc(
      'week',
      OLD.start_time AT TIME ZONE 'America/Toronto'
    )::date;
    PERFORM timesheets.refresh_user_overtime_week(OLD.user_id, old_week_start);
  END IF;

  IF TG_OP = 'INSERT' THEN
    new_week_start := date_trunc(
      'week',
      NEW.start_time AT TIME ZONE 'America/Toronto'
    )::date;
    PERFORM timesheets.refresh_user_overtime_week(NEW.user_id, new_week_start);
  ELSIF TG_OP = 'UPDATE' THEN
    new_week_start := date_trunc(
      'week',
      NEW.start_time AT TIME ZONE 'America/Toronto'
    )::date;

    IF NEW.user_id IS DISTINCT FROM OLD.user_id
      OR new_week_start IS DISTINCT FROM old_week_start THEN
      PERFORM timesheets.refresh_user_overtime_week(NEW.user_id, new_week_start);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sync_user_overtime_week
  ON timesheets.work_sessions;

CREATE TRIGGER sync_user_overtime_week
AFTER INSERT OR UPDATE OF user_id, start_time, end_time, duration_minutes, lunch_duration
OR DELETE
ON timesheets.work_sessions
FOR EACH ROW
EXECUTE FUNCTION timesheets.sync_user_overtime_week();

INSERT INTO timesheets.user_overtime_weeks (
  user_id,
  week_start,
  total_minutes,
  banked_minutes,
  updated_at
)
SELECT
  ws.user_id,
  date_trunc(
    'week',
    ws.start_time AT TIME ZONE 'America/Toronto'
  )::date,
  GREATEST(
    0,
    SUM(
      COALESCE(
        ws.duration_minutes,
        ROUND(EXTRACT(EPOCH FROM ws.end_time - ws.start_time) / 60)
      )
    ) - SUM(COALESCE(ws.lunch_duration, 0))
  )::bigint,
  GREATEST(
    0,
    SUM(
      COALESCE(
        ws.duration_minutes,
        ROUND(EXTRACT(EPOCH FROM ws.end_time - ws.start_time) / 60)
      )
    ) - SUM(COALESCE(ws.lunch_duration, 0)) - 2400
  )::bigint,
  NOW()
FROM timesheets.work_sessions ws
WHERE ws.end_time IS NOT NULL
GROUP BY ws.user_id, date_trunc(
  'week',
  ws.start_time AT TIME ZONE 'America/Toronto'
)::date
ON CONFLICT (user_id, week_start)
DO UPDATE SET
  total_minutes = EXCLUDED.total_minutes,
  banked_minutes = EXCLUDED.banked_minutes,
  updated_at = NOW();

INSERT INTO timesheets.user_overtime_totals (
  user_id,
  total_banked_minutes,
  updated_at
)
SELECT
  ow.user_id,
  SUM(ow.banked_minutes)::bigint,
  NOW()
FROM timesheets.user_overtime_weeks ow
GROUP BY ow.user_id
ON CONFLICT (user_id)
DO UPDATE SET
  total_banked_minutes = EXCLUDED.total_banked_minutes,
  updated_at = NOW();

COMMIT;
