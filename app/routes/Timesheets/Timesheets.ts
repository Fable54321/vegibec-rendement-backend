import { Router } from "express";
import { pool } from "../../db";

const router = Router();

router.get("/active", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;

    const result = await pool.query(
      `
            SELECT *
            FROM timesheets.work_sessions
            WHERE user_id = $1
              AND end_time IS NULL
            LIMIT 1
            `,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.json({ hasActiveSession: false });
    }

    const session = result.rows[0];

    const start = new Date(session.start_time);
    const now = new Date();
    const hoursOpen = (now.getTime() - start.getTime()) / 1000 / 60 / 60;

    return res.json({
      hasActiveSession: true,
      session,
      isLongSession: hoursOpen > 10,
    });
  } catch (err) {
    console.error("Error fetching active session:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/start", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;
    const { description } = req.body;

    // Optional: prevent multiple active sessions
    const existing = await pool.query(
      `
            SELECT id FROM timesheets.work_sessions
            WHERE user_id = $1 AND end_time IS NULL
            `,
      [userId],
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        error: "Une session est déjà en cours",
      });
    }

    const result = await pool.query(
      `
            INSERT INTO timesheets.work_sessions (user_id, description, start_time)
            VALUES ($1, $2, NOW())
            RETURNING *
            `,
      [userId, description || ""],
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error starting session:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/stop", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;

    const result = await pool.query(
      `
            UPDATE timesheets.work_sessions
            SET end_time = NOW()
            WHERE user_id = $1
              AND end_time IS NULL
            RETURNING *
            `,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        error: "Aucune session active",
      });
    }

    const session = result.rows[0];

    const start = new Date(session.start_time);
    const end = new Date(session.end_time);

    const totalMinutes = Math.round(
      (end.getTime() - start.getTime()) / 1000 / 60,
    );

    res.json({
      ...session,
      totalMinutes,
    });
  } catch (err) {
    console.error("Error stopping session:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
