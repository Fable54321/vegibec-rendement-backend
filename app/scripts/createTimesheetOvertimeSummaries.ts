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
    WITH calculated AS (
      SELECT
        ws.user_id,
        date_trunc(
          'week',
          ws.start_time AT TIME ZONE 'America/Toronto'
        )::date AS week_start,
        GREATEST(
          0,
          SUM(
            COALESCE(
              ws.duration_minutes,
              ROUND(EXTRACT(EPOCH FROM ws.end_time - ws.start_time) / 60)
            )
          ) - SUM(COALESCE(ws.lunch_duration, 0))
        )::bigint AS total_minutes
      FROM timesheets.work_sessions ws
      WHERE ws.end_time IS NOT NULL
      GROUP BY ws.user_id, week_start
    )
    SELECT COUNT(*)::text AS mismatch_count
    FROM calculated c
    FULL JOIN timesheets.user_overtime_weeks ow
      USING (user_id, week_start)
    WHERE c.user_id IS NULL
      OR ow.user_id IS NULL
      OR c.total_minutes IS DISTINCT FROM ow.total_minutes
      OR GREATEST(0, c.total_minutes - 2400)
        IS DISTINCT FROM ow.banked_minutes
  `);

  if (verification.rows[0].mismatch_count !== "0") {
    throw new Error("The overtime backfill did not match existing sessions.");
  }

  console.log("Timesheet overtime summaries are ready and verified.");
};

run()
  .catch((error) => {
    console.error("Unable to create timesheet overtime summaries:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
