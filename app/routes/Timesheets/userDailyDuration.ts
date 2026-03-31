import { Router } from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = Router();

router.get("/daily-duration/:userId", requireAppRole("time", ["admin"]), async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      return res.status(400).json({ error: "ID utilisateur invalide" });
    }

    const start = typeof req.query.start === "string" ? req.query.start : null;
    const end = typeof req.query.end === "string" ? req.query.end : null;
    const dateField =
      req.query.by === "start_time" ? "ws.start_time" : "ws.created_at";

    if (start && isNaN(Date.parse(start))) {
      return res.status(400).json({ error: "Date de début invalide" });
    }

    if (end && isNaN(Date.parse(end))) {
      return res.status(400).json({ error: "Date de fin invalide" });
    }

    const values: any[] = [userId];
    const whereClauses = ["ws.user_id = $1", "ws.end_time IS NOT NULL"];

    if (start) {
      values.push(start);
      whereClauses.push(
        `( ${dateField} AT TIME ZONE 'America/Toronto')::date >= $${values.length}::date`,
      );
    }

    if (end) {
      values.push(end);
      whereClauses.push(
        `( ${dateField} AT TIME ZONE 'America/Toronto')::date <= $${values.length}::date`,
      );
    }

    const result = await pool.query(
      `
      SELECT
        ( ${dateField} AT TIME ZONE 'America/Toronto')::date AS day,
        SUM(
          COALESCE(
            duration_minutes,
            ROUND(EXTRACT(EPOCH FROM ws.end_time - ws.start_time) / 60)
          )
        ) AS total_minutes,
        SUM(
          COALESCE(
            duration_minutes,
            ROUND(EXTRACT(EPOCH FROM ws.end_time - ws.start_time) / 60)
          )
        ) / 60.0 AS total_hours
      FROM timesheets.work_sessions ws
      WHERE ${whereClauses.join(" AND ")}
      GROUP BY day
      ORDER BY day DESC
      `,
      values,
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching daily duration for user:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;