import { pool } from "../../db"
import Router from "express"
import { requireAppRole } from "../../middleware/auth";

const router = Router();


const parseDateInput = (value: unknown): Date | null => {
  if (typeof value !== "string" && !(value instanceof Date)) {
    return null;
  }

  const parsed = new Date(value);

  return isNaN(parsed.getTime()) ? null : parsed;
};



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


router.get(
  "/blocks/by-user",
  requireAppRole("time", ["admin", "dev"]),
  async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Non autorisé" });
      }

      const userId = Number(req.query.user_id);
      const date = typeof req.query.date === "string" ? req.query.date : null;

      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: "user_id invalide" });
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
          ws.dinner_duration,
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
          has_unapproved_edits: false,
          unapproved_blocks_count: 0,
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

      const editsSummaryResult = await pool.query(
        `
        SELECT
          work_session_id,
          COUNT(*)::int AS edits_count,
          COUNT(*) FILTER (WHERE is_approved = false)::int AS unapproved_edits_count
        FROM timesheets.work_session_edits
        WHERE work_session_id = ANY($1::int[])
        GROUP BY work_session_id
        `,
        [sessionIds],
      );

      const editsSummaryBySession = new Map<
        number,
        { edits_count: number; unapproved_edits_count: number }
      >();

      for (const row of editsSummaryResult.rows) {
        editsSummaryBySession.set(Number(row.work_session_id), {
          edits_count: Number(row.edits_count),
          unapproved_edits_count: Number(row.unapproved_edits_count),
        });
      }

      const blocks = sessions.map((session) => {
        const summary = editsSummaryBySession.get(Number(session.id));

        const unapprovedEditsCount = summary?.unapproved_edits_count ?? 0;

        return {
          ...session,
          notes: notesBySession.get(Number(session.id)) || [],
          edits_count: summary?.edits_count ?? 0,
          unapproved_edits_count: unapprovedEditsCount,
          has_unapproved_edits: unapprovedEditsCount > 0,
        };
      });

      const unapprovedBlocksCount = blocks.filter(
        (block) => block.has_unapproved_edits,
      ).length;

      res.json({
        date,
        has_unapproved_edits: unapprovedBlocksCount > 0,
        unapproved_blocks_count: unapprovedBlocksCount,
        blocks,
      });
    } catch (err) {
      console.error("Error fetching work blocks by user:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  },
);


router.patch(
  "/blocks/:blockId/users/:userId",
  requireAppRole("time", ["admin", "dev"]),
  async (req, res) => {
    const client = await pool.connect();

    try {
      if (!req.user) {
        return res.status(401).json({ error: "Non autorisÃ©" });
      }

      const blockId = Number(req.params.blockId);
      const userId = Number(req.params.userId);
      const { start_time, end_time, reason } = req.body;

      if (!Number.isInteger(blockId) || blockId <= 0) {
        return res.status(400).json({ error: "ID de bloc invalide" });
      }

      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: "ID utilisateur invalide" });
      }

      if (start_time === undefined && end_time === undefined) {
        return res.status(400).json({ error: "Aucune heure fournie" });
      }

      await client.query("BEGIN");

      const ownershipResult = await client.query(
        `
        SELECT id, user_id, start_time, end_time
        FROM timesheets.work_sessions
        WHERE id = $1
          AND user_id = $2
        FOR UPDATE
        `,
        [blockId, userId],
      );

      if (ownershipResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Bloc introuvable pour cet utilisateur" });
      }

      const existingSession = ownershipResult.rows[0];
      const existingStartTime = new Date(existingSession.start_time);
      const existingEndTime = existingSession.end_time
        ? new Date(existingSession.end_time)
        : null;

      let newStartTime = existingStartTime;
      let newEndTime = existingEndTime;

      if (start_time !== undefined) {
        const parsedStartTime = parseDateInput(start_time);

        if (!parsedStartTime) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Heure de début invalide" });
        }

        newStartTime = parsedStartTime;
      }

      if (end_time !== undefined) {
        if (end_time === null || end_time === "") {
          newEndTime = null;
        } else {
          const parsedEndTime = parseDateInput(end_time);

          if (!parsedEndTime) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Heure de fin invalide" });
          }

          newEndTime = parsedEndTime;
        }
      }

      if (newEndTime && newStartTime >= newEndTime) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "L'heure de fin doit être après l'heure de début" });
      }

      const hasTimeChanged =
        existingStartTime.getTime() !== newStartTime.getTime() ||
        (existingEndTime === null ? null : existingEndTime.getTime()) !==
          (newEndTime === null ? null : newEndTime.getTime());

      if (!hasTimeChanged) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Aucune modification détectée" });
      }

      const editResult = await client.query(
        `
        INSERT INTO timesheets.work_session_edits (
          work_session_id,
          previous_start_time,
          previous_end_time,
          new_start_time,
          new_end_time,
          reason,
          edited_by_user_id,
          is_approved
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        RETURNING
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
          created_at,
          is_approved
        `,
        [
          blockId,
          existingStartTime,
          existingEndTime,
          newStartTime,
          newEndTime,
          typeof reason === "string" ? reason.trim() || null : null,
          req.user.id,
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
        RETURNING
          *,
          CASE
            WHEN end_time IS NULL THEN NULL
            ELSE ROUND(EXTRACT(EPOCH FROM (end_time - start_time)) / 60)
          END AS total_minutes
        `,
        [newStartTime, newEndTime, blockId],
      );

      await client.query("COMMIT");

      res.json({
        block: updateResult.rows[0],
        edit: editResult.rows[0],
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error updating admin work block:", err);
      res.status(500).json({ error: "Erreur serveur" });
    } finally {
      client.release();
    }
  },
);


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
        created_at,
        is_approved
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


router.patch(
  "/edits/:editId/approval",
  requireAppRole("time", ["admin", "dev"]),
  async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Non autorisé" });
      }

      const editId = Number(req.params.editId);
      const { isApproved } = req.body;

      if (!Number.isInteger(editId) || editId <= 0) {
        return res.status(400).json({ error: "ID de modification invalide" });
      }

      if (typeof isApproved !== "boolean") {
        return res.status(400).json({ error: "isApproved doit être un booléen" });
      }

      const result = await pool.query(
        `
        UPDATE timesheets.work_session_edits
        SET is_approved = $2
        WHERE id = $1
        RETURNING
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
          created_at,
          is_approved
        `,
        [editId, isApproved],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Modification introuvable" });
      }

      res.json({
        message: isApproved
          ? "Modification approuvée avec succès"
          : "Approbation retirée avec succès",
        edit: result.rows[0],
      });
    } catch (err) {
      console.error("Error updating work session edit approval:", err);
      res.status(500).json({ error: "Erreur serveur" });
    }
  },
);

export default router;
