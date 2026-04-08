import { pool } from "../../db"
import Router from "express"
import { requireAppRole } from "../../middleware/auth";

const router = Router();




router.get("/users/with-worksheet", requireAppRole("time", ["admin", "user", "guest", "dev"]), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.username,
        u.email,
        u.name,
        u.surname,
        u.uses_worksheet,
        COALESCE(
          json_agg(
            json_build_object(
              'app_id', a.id,
              'slug', a.slug,
              'role', uar.role
            )
          ) FILTER (WHERE a.id IS NOT NULL),
          '[]'
        ) AS app_roles
      FROM users u
      LEFT JOIN user_app_roles uar ON u.id = uar.user_id
      LEFT JOIN apps a ON uar.app_id = a.id
      WHERE u.uses_worksheet = TRUE
      GROUP BY u.id
      ORDER BY u.name, u.surname
    `);

    return res.json({
      success: true,
      users: result.rows,
    });
  } catch (err) {
    console.error("Error fetching users with worksheet:", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});


router.get("/blocks/by-user", requireAppRole("time", ["admin", "dev"]) ,async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

   

    const userId = Number(req.query.user_id);
    const date = typeof req.query.date === "string" ? req.query.date : null;

    if (!userId) {
      return res.status(400).json({ error: "user_id requis" });
    }

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
    console.error("Error fetching work blocks by user:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


router.get("/blocks/:blockId/users/:userId/edits", requireAppRole("time", ["admin", "dev"]) , async (req, res) => {
  try {

    
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

  

    const blockId = Number(req.params.blockId);
    const userId = Number(req.params.userId);

    if (!Number.isInteger(blockId) || blockId <= 0) {
      return res.status(400).json({ error: "ID de bloc invalide" });
    }

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "ID utilisateur invalide" });
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
      return res.status(404).json({ error: "Bloc introuvable pour cet utilisateur" });
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
      userId,
      edits: editsResult.rows,
    });
  } catch (err) {
    console.error("Error fetching admin block edits:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;