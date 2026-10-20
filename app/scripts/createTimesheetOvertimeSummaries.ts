import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:
    process.env.DB_SSL === "true"
      ? {
          rejectUnauthorized: false,
        }
      : false,
});

const run = async () => {
  const sqlPath = path.join(
    __dirname,
    "createTimesheetOvertimeSummaries.sql",
  );
  const sql = await fs.readFile(sqlPath, "utf8");

  await pool.query(sql);
  const verification = await pool.query<{ mismatch_count: string }>(`
    WITH candidate_weeks AS (
      SELECT DISTINCT
        ws.user_id,
        date_trunc(
          'week',
          ws.start_time AT TIME ZONE 'America/Toronto'
        )::date AS week_start
      FROM timesheets.work_sessions ws
      WHERE ws.end_time IS NOT NULL

      UNION

      SELECT
        u.id AS user_id,
        date_trunc('week', ph.holiday_date)::date AS week_start
      FROM public.users u
      CROSS JOIN timesheets.public_holidays ph
      WHERE u.uses_worksheet = TRUE
        AND u.is_active = TRUE
        AND u.created_at::date <= ph.holiday_date
        AND ph.is_active = TRUE
    ),
    calculated AS (
      SELECT
        candidate.user_id,
        candidate.week_start,
        GREATEST(
          0,
          COALESCE((
            SELECT SUM(
              COALESCE(
                ws.duration_minutes,
                ROUND(EXTRACT(EPOCH FROM ws.end_time - ws.start_time) / 60)
              ) - COALESCE(ws.lunch_duration, 0)
            )
            FROM timesheets.work_sessions ws
            WHERE ws.user_id = candidate.user_id
              AND ws.end_time IS NOT NULL
              AND date_trunc(
                'week',
                ws.start_time AT TIME ZONE 'America/Toronto'
              )::date = candidate.week_start
          ), 0)
        )::bigint AS worked_minutes,
        COALESCE((
          SELECT SUM(ph.credited_minutes)
          FROM timesheets.public_holidays ph
          WHERE ph.is_active = TRUE
            AND ph.holiday_date BETWEEN
              candidate.week_start AND candidate.week_start + 6
            AND NOT EXISTS (
              SELECT 1
              FROM timesheets.work_sessions holiday_session
              WHERE holiday_session.user_id = candidate.user_id
                AND holiday_session.end_time IS NOT NULL
                AND (
                  holiday_session.start_time AT TIME ZONE 'America/Toronto'
                )::date = ph.holiday_date
            )
        ), 0)::bigint AS holiday_minutes
      FROM candidate_weeks candidate
    )
    SELECT COUNT(*)::text AS mismatch_count
    FROM calculated c
    FULL JOIN timesheets.user_overtime_weeks ow
      USING (user_id, week_start)
    WHERE c.user_id IS NULL
      OR ow.user_id IS NULL
      OR c.worked_minutes IS DISTINCT FROM ow.worked_minutes
      OR c.holiday_minutes IS DISTINCT FROM ow.holiday_minutes
      OR c.worked_minutes + c.holiday_minutes
        IS DISTINCT FROM ow.total_minutes
      OR GREATEST(
        0,
        c.worked_minutes + c.holiday_minutes - 2400
      )
        IS DISTINCT FROM ow.banked_minutes
  `);

  if (verification.rows[0].mismatch_count !== "0") {
    throw new Error("The overtime backfill did not match existing sessions.");
  }

  const totalVerification = await pool.query<{ mismatch_count: string }>(`
    WITH calculated AS (
      SELECT
        ow.user_id,
        SUM(ow.banked_minutes)::bigint AS total_banked_minutes
      FROM timesheets.user_overtime_weeks ow
      GROUP BY ow.user_id
    )
    SELECT COUNT(*)::text AS mismatch_count
    FROM calculated c
    FULL JOIN timesheets.user_overtime_totals ot USING (user_id)
    WHERE c.user_id IS NULL
      OR ot.user_id IS NULL
      OR c.total_banked_minutes
        IS DISTINCT FROM ot.total_banked_minutes
  `);

  if (totalVerification.rows[0].mismatch_count !== "0") {
    throw new Error("The per-user overtime totals did not match weekly data.");
  }

  console.log("Timesheet overtime summaries are ready and verified.");
};

run()
  .catch((error) => {
    console.error("Unable to create timesheet overtime summaries:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
