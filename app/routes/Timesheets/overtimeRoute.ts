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
  const whereClauses = ["ow.user_id = $1"];

  if (start) {
    values.push(start);
    whereClauses.push(
      `ow.week_start >= date_trunc('week', $${values.length}::date)::date`,
    );
  }

  if (end) {
    values.push(end);
    whereClauses.push(
      `ow.week_start <= date_trunc('week', $${values.length}::date)::date`,
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
      SELECT
        ow.week_start,
        ow.week_start + 6 AS week_end,
        ow.total_minutes,
        ow.total_minutes / 60.0 AS total_hours,
        ow.banked_minutes,
        ow.banked_minutes / 60.0 AS banked_hours
      FROM timesheets.user_overtime_weeks ow
      WHERE ${filter.whereClauses.join(" AND ")}
      ORDER BY ow.week_start DESC
    `,
    filter.values,
  );

  const hasDateFilter =
    typeof query.start === "string" || typeof query.end === "string";
  let totalBankedMinutes: number;

  if (hasDateFilter) {
    totalBankedMinutes = result.rows.reduce(
      (total, week) => total + Number(week.banked_minutes),
      0,
    );
  } else {
    const totalResult = await pool.query(
      `
        SELECT total_banked_minutes
        FROM timesheets.user_overtime_totals
        WHERE user_id = $1
      `,
      [userId],
    );
    totalBankedMinutes = Number(
      totalResult.rows[0]?.total_banked_minutes ?? 0,
    );
  }

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
