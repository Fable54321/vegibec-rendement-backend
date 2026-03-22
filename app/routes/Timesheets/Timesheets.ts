import { Router } from "express";
import { pool } from "../../db";

const router = Router();

router.get("/blocks", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;
    const date = typeof req.query.date === "string" ? req.query.date : null;

    if (!date) {
      return res.status(400).json({ error: "La date est requise" });
    }

    const sessionsResult = await pool.query(
      `
      SELECT
        ws.id,
        ws.user_id,
        ws.start_time,
        ws.end_time,
        ws.created_at,
        ws.updated_at,
        ROUND(EXTRACT(EPOCH FROM (ws.end_time - ws.start_time)) / 60) AS total_minutes
      FROM timesheets.work_sessions ws
      WHERE ws.user_id = $1
        AND ws.end_time IS NOT NULL
        AND (ws.start_time AT TIME ZONE 'America/Toronto')::date = $2::date
      ORDER BY ws.start_time DESC
      `,
      [userId, date],
    );

    const sessions = sessionsResult.rows;

    if (sessions.length === 0) {
      return res.json({
        date,
        blocks: [],
      });
    }

    const sessionIds = sessions.map((s) => Number(s.id));

    const notesResult = await pool.query(
      `
      SELECT
        id,
        work_session_id,
        note,
        created_at
      FROM timesheets.work_session_notes
      WHERE work_session_id = ANY($1::int[])
      ORDER BY created_at ASC
      `,
      [sessionIds],
    );

    const notesBySession = new Map<number, typeof notesResult.rows>();

    for (const note of notesResult.rows) {
      const arr = notesBySession.get(note.work_session_id) || [];
      arr.push(note);
      notesBySession.set(note.work_session_id, arr);
    }

    const blocks = sessions.map((session) => ({
      ...session,
      notes: notesBySession.get(session.id) || [],
    }));

    res.json({
      date,
      blocks,
    });
  } catch (err) {
    console.error("Error fetching work blocks:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

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

    const notesResult = await pool.query(
      `
      SELECT
        id,
        work_session_id,
        note,
        created_at
      FROM timesheets.work_session_notes
      WHERE work_session_id = $1
      ORDER BY created_at ASC
      `,
      [session.id],
    );

    const start = new Date(session.start_time);
    const now = new Date();
    const hoursOpen = (now.getTime() - start.getTime()) / 1000 / 60 / 60;

    return res.json({
      hasActiveSession: true,
      session,
      notes: notesResult.rows,
      isLongSession: hoursOpen > 10,
    });
  } catch (err) {
    console.error("Error fetching active session:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/description", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;
    const { description } = req.body;

    if (!description || !description.trim()) {
      return res.status(400).json({ error: "La description est requise" });
    }

    await client.query("BEGIN");

    const sessionResult = await client.query(
      `
      SELECT id
      FROM timesheets.work_sessions
      WHERE user_id = $1
        AND end_time IS NULL
      LIMIT 1
      `,
      [userId],
    );

    if (sessionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Aucune session active" });
    }

    const sessionId = sessionResult.rows[0].id;

    const noteResult = await client.query(
      `
      INSERT INTO timesheets.work_session_notes (work_session_id, note)
      VALUES ($1, $2)
      RETURNING *
      `,
      [sessionId, description.trim()],
    );

    await client.query(
      `
      UPDATE timesheets.work_sessions
      SET updated_at = NOW()
      WHERE id = $1
      `,
      [sessionId],
    );

    await client.query("COMMIT");

    res.status(201).json(noteResult.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error adding session note:", err);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

router.post("/start", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;
    const { description } = req.body;

    await client.query("BEGIN");

    const existing = await client.query(
      `
      SELECT id
      FROM timesheets.work_sessions
      WHERE user_id = $1
        AND end_time IS NULL
      `,
      [userId],
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Une session est déjà en cours",
      });
    }

    const sessionResult = await client.query(
      `
      INSERT INTO timesheets.work_sessions (user_id, start_time)
      VALUES ($1, NOW())
      RETURNING *
      `,
      [userId],
    );

    const session = sessionResult.rows[0];
    let firstNote = null;

    if (description && description.trim()) {
      const noteResult = await client.query(
        `
        INSERT INTO timesheets.work_session_notes (work_session_id, note)
        VALUES ($1, $2)
        RETURNING *
        `,
        [session.id, description.trim()],
      );

      firstNote = noteResult.rows[0];
    }

    await client.query("COMMIT");

    res.status(201).json({
      session,
      firstNote,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error starting session:", err);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

router.post("/stop", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;
    const { description } = req.body;

    await client.query("BEGIN");

    const activeResult = await client.query(
      `
      SELECT *
      FROM timesheets.work_sessions
      WHERE user_id = $1
        AND end_time IS NULL
      LIMIT 1
      `,
      [userId],
    );

    if (activeResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Aucune session active",
      });
    }

    const activeSession = activeResult.rows[0];

    let finalNote = null;

    if (description && description.trim()) {
      const noteResult = await client.query(
        `
        INSERT INTO timesheets.work_session_notes (work_session_id, note)
        VALUES ($1, $2)
        RETURNING *
        `,
        [activeSession.id, description.trim()],
      );

      finalNote = noteResult.rows[0];
    }

    const stopResult = await client.query(
      `
      UPDATE timesheets.work_sessions
      SET end_time = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [activeSession.id],
    );

    const session = stopResult.rows[0];

    const notesResult = await client.query(
      `
      SELECT
        id,
        work_session_id,
        note,
        created_at
      FROM timesheets.work_session_notes
      WHERE work_session_id = $1
      ORDER BY created_at ASC
      `,
      [session.id],
    );

    await client.query("COMMIT");

    const start = new Date(session.start_time);
    const end = new Date(session.end_time);

    const totalMinutes = Math.round(
      (end.getTime() - start.getTime()) / 1000 / 60,
    );

    res.json({
      session,
      notes: notesResult.rows,
      finalNote,
      totalMinutes,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error stopping session:", err);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

export default router;
