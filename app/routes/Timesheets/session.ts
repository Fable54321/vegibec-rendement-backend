import { Router } from "express";
import { pool } from "../../db";

const router = Router();
const MAX_NOTE_LENGTH = 1000;

const parseDateInput = (value: unknown): Date | null => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parsedDate;
};

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
        ws.is_modified,
        ws.modified_at,
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
      const workSessionId = Number(note.work_session_id);
      const arr = notesBySession.get(workSessionId) || [];
      arr.push(note);
      notesBySession.set(workSessionId, arr);
    }

    const blocks = sessions.map((session) => ({
      ...session,
      notes: notesBySession.get(Number(session.id)) || [],
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

router.post("/blocks", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorise" });
    }

    const userId = req.user.id;
    const startTime = parseDateInput(req.body.start_time);
    const endTime = parseDateInput(req.body.end_time);
    



    if (!startTime) {
      return res.status(400).json({ error: "L'heure de debut est requise" });
    }

    if (!endTime) {
      return res.status(400).json({ error: "L'heure de fin est requise" });
    }

    if (startTime >= endTime) {
      return res
        .status(400)
        .json({ error: "L'heure de fin doit etre apres l'heure de debut" });
    }

    

    await client.query("BEGIN");

    const insertResult = await client.query(
      `
      INSERT INTO timesheets.work_sessions (user_id, start_time, end_time)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [userId, startTime, endTime],
    );

    await client.query("COMMIT");

    const session = insertResult.rows[0];
    const totalMinutes = Math.round(
      (new Date(session.end_time).getTime() -
        new Date(session.start_time).getTime()) /
        1000 /
        60,
    );

    res.status(201).json({
      session,
      totalMinutes,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error creating work block:", err);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

router.post("/blocks/:blockId/notes", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorise" });
    }

    const userId = req.user.id;
    const blockId = Number(req.params.blockId);
    const rawNote =
      typeof req.body.note === "string"
        ? req.body.note
        : typeof req.body.description === "string"
          ? req.body.description
          : "";
    const note = rawNote.trim();

    if (!Number.isInteger(blockId) || blockId <= 0) {
      return res.status(400).json({ error: "ID de bloc invalide" });
    }

    if (!note) {
      return res.status(400).json({ error: "La note est requise" });
    }

    if (note.length > MAX_NOTE_LENGTH) {
      return res.status(400).json({ error: "La note est trop longue" });
    }

    await client.query("BEGIN");

    const ownershipResult = await client.query(
      `
      SELECT id
      FROM timesheets.work_sessions
      WHERE id = $1
        AND user_id = $2
      `,
      [blockId, userId],
    );

    if (ownershipResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Bloc introuvable" });
    }

    const noteResult = await client.query(
      `
      INSERT INTO timesheets.work_session_notes (work_session_id, note)
      VALUES ($1, $2)
      RETURNING
        id,
        work_session_id,
        note,
        created_at
      `,
      [blockId, note],
    );

    await client.query(
      `
      UPDATE timesheets.work_sessions
      SET updated_at = NOW()
      WHERE id = $1
      `,
      [blockId],
    );

    await client.query("COMMIT");

    res.status(201).json(noteResult.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error adding note to work block:", err);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

// Modify block and save the old version to history

router.patch("/blocks/:blockId", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;
    const blockId = Number(req.params.blockId);
    const { start_time, end_time, reason } = req.body;

    if (!Number.isInteger(blockId) || blockId <= 0) {
      return res.status(400).json({ error: "ID de bloc invalide" });
    }

    await client.query("BEGIN");

    const ownershipResult = await client.query(
      `
      SELECT id, start_time, end_time
      FROM timesheets.work_sessions
      WHERE id = $1
        AND user_id = $2
      `,
      [blockId, userId],
    );

    if (ownershipResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Bloc introuvable" });
    }

    const existingSession = ownershipResult.rows[0];

    let newStartTime = existingSession.start_time;
    let newEndTime = existingSession.end_time;

    if (start_time) {
      newStartTime = new Date(start_time);
      if (isNaN(newStartTime.getTime())) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Heure de début invalide" });
      }
    }

    if (end_time !== undefined) {
      newEndTime = end_time ? new Date(end_time) : null;

      if (end_time && newEndTime && isNaN(newEndTime.getTime())) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Heure de fin invalide" });
      }
    }

    if (newEndTime && newStartTime >= newEndTime) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "L'heure de fin doit être après l'heure de début" });
    }

    const hasTimeChanged =
      new Date(existingSession.start_time).getTime() !==
        new Date(newStartTime).getTime() ||
      (existingSession.end_time === null
        ? null
        : new Date(existingSession.end_time).getTime()) !==
        (newEndTime === null ? null : new Date(newEndTime).getTime());

    if (!hasTimeChanged) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Aucune modification détectée" });
    }

    await client.query(
      `
      INSERT INTO timesheets.work_session_edits (
        work_session_id,
        previous_start_time,
        previous_end_time,
        new_start_time,
        new_end_time,
        reason,
        edited_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        blockId,
        existingSession.start_time,
        existingSession.end_time,
        newStartTime,
        newEndTime,
        reason?.trim() || null,
        userId,
      ],
    );

    const updateResult = await client.query(
      `
      UPDATE timesheets.work_sessions
      SET start_time = $1,
          end_time = $2,
          updated_at = NOW(),
          is_modified = true,
          modified_at = NOW()
      WHERE id = $3
      RETURNING *
      `,
      [newStartTime, newEndTime, blockId],
    );

    await client.query("COMMIT");

    res.json(updateResult.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating block:", err);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

//See edits mades to a block

router.get("/blocks/:blockId/edits", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;
    const blockId = Number(req.params.blockId);

    if (!Number.isInteger(blockId) || blockId <= 0) {
      return res.status(400).json({ error: "ID de bloc invalide" });
    }

    const ownershipResult = await pool.query(
      `
      SELECT id
      FROM timesheets.work_sessions
      WHERE id = $1
        AND user_id = $2
      `,
      [blockId, userId],
    );

    if (ownershipResult.rows.length === 0) {
      return res.status(404).json({ error: "Bloc introuvable" });
    }

    const editsResult = await pool.query(
      `
      SELECT
        id,
        work_session_id,
        previous_start_time,
        previous_end_time,
        new_start_time,
        new_end_time,
        previous_duration_minutes,
        new_duration_minutes,
        reason,
        edited_by_user_id,
        created_at
      FROM timesheets.work_session_edits
      WHERE work_session_id = $1
      ORDER BY created_at DESC
      `,
      [blockId],
    );

    res.json({
      blockId,
      edits: editsResult.rows,
    });
  } catch (err) {
    console.error("Error fetching block edits:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.delete("/blocks/:blockId", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;
    const blockId = Number(req.params.blockId);

    if (!Number.isInteger(blockId) || blockId <= 0) {
      return res.status(400).json({ error: "ID de bloc invalide" });
    }

    await client.query("BEGIN");

    // Check ownership
    const ownershipResult = await client.query(
      `
      SELECT id
      FROM timesheets.work_sessions
      WHERE id = $1 AND user_id = $2
      `,
      [blockId, userId],
    );

    if (ownershipResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Bloc introuvable" });
    }

    // Delete notes first (if cascade not set)
    await client.query(
      `
      DELETE FROM timesheets.work_session_notes
      WHERE work_session_id = $1
      `,
      [blockId],
    );

    // Delete session
    const deleteResult = await client.query(
      `
      DELETE FROM timesheets.work_sessions
      WHERE id = $1
      RETURNING *
      `,
      [blockId],
    );

    await client.query("COMMIT");

    res.json({
      message: "Bloc supprimé",
      deletedBlock: deleteResult.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error deleting block:", err);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

export default router;
