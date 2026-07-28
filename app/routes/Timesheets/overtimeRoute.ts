import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

type OvertimeQuery = {
  start?: unknown;
  end?: unknown;
};

const getDateFilter = (query: OvertimeQuery, userId: number) => {
  const start = typeof query.start === "string" ? query.start : null;
  const end = typeof query.end === "string" ? query.end : null;

  if (start && isNaN(Date.parse(start))) {
    return { error: "Date de début invalide" };
  }

  if (end && isNaN(Date.parse(end))) {
    return { error: "Date de fin invalide" };
  }

  const values: Array<number | string> = [userId];
  const whereClauses = ["ws.user_id = $1", "ws.end_time IS NOT NULL"];

  if (start) {
    values.push(start);
    whereClauses.push(
      `(ws.start_time AT TIME ZONE 'America/Toronto')::date >= $${values.length}::date`,
    );
  }

  if (end) {
    values.push(end);
    whereClauses.push(
      `(ws.start_time AT TIME ZONE 'America/Toronto')::date <= $${values.length}::date`,
    );
  }

  return { values, whereClauses };
};

const getOvertime = async (userId: number, query: OvertimeQuery) => {
  const filter = getDateFilter(query, userId);

  if ("error" in filter) {
    return filter;
  }

  const result = await pool.query(
    `
      WITH weekly_sessions AS (
        SELECT
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
        WHERE ${filter.whereClauses.join(" AND ")}
        GROUP BY week_start
      )
      SELECT
        week_start,
        week_start + 6 AS week_end,
        total_minutes,
        total_minutes / 60.0 AS total_hours,
        GREATEST(0, total_minutes - 2400)::bigint AS banked_minutes,
        GREATEST(0, total_minutes - 2400) / 60.0 AS banked_hours
      FROM weekly_sessions
      ORDER BY week_start DESC
    `,
    filter.values,
  );

  const totalBankedMinutes = result.rows.reduce(
    (total, week) => total + Number(week.banked_minutes),
    0,
  );

  return {
    weeks: result.rows,
    total_banked_minutes: totalBankedMinutes,
    total_banked_hours: totalBankedMinutes / 60,
  };
};

router.get("/", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const result = await getOvertime(req.user.id, req.query);

    if ("error" in result) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (err) {
    console.error("Error fetching overtime:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get(
  "/:userId",
  requireAppRole("time", ["admin", "dev"]),
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);

      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: "ID utilisateur invalide" });
      }

      const result = await getOvertime(userId, req.query);

      if ("error" in result) {
        return res.status(400).json(result);
      }

      return res.json(result);
    } catch (err) {
      console.error("Error fetching overtime for user:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  },
);

export default router;
