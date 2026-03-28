import { Router } from "express";
import { pool } from "../../db";

const router = Router();

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

router.patch("/notes/:noteId", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;
    const noteId = Number(req.params.noteId);
    const { note } = req.body;

    if (!Number.isInteger(noteId) || noteId <= 0) {
      return res.status(400).json({ error: "ID de tâche invalide" });
    }

    if (!note || !note.trim()) {
      return res.status(400).json({ error: "La tâche est requise" });
    }

    const result = await pool.query(
      `
      UPDATE timesheets.work_session_notes n
      SET note = $2
      FROM timesheets.work_sessions ws
      WHERE n.id = $1
        AND n.work_session_id = ws.id
        AND ws.user_id = $3
      RETURNING
        n.id,
        n.work_session_id,
        n.note,
        n.created_at
      `,
      [noteId, note.trim(), userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Note introuvable" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erreur dans la modification de la tâche", err);
    res.status(500).json({ error: "Erreur Serveur" });
  }
});

router.delete("/notes/:noteId", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;
    const noteId = Number(req.params.noteId);

    if (!Number.isInteger(noteId) || noteId <= 0) {
      return res.status(400).json({ error: "ID de note invalide" });
    }

    const result = await pool.query(
      `
      DELETE FROM timesheets.work_session_notes n
      USING timesheets.work_sessions ws
      WHERE n.id = $1
        AND n.work_session_id = ws.id
        AND ws.user_id = $2
      RETURNING
        n.id,
        n.work_session_id,
        n.note,
        n.created_at
      `,
      [noteId, userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Note introuvable" });
    }

    res.json({
      message: "Note supprimée",
      deletedNote: result.rows[0],
    });
  } catch (err) {
    console.error("Error deleting note:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
