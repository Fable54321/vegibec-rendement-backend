

import crypto from "crypto"
import { Router } from "express"
import multer from "multer"
import path from "path"

import { pool } from "../../db"
import { requireAppRole } from "../../middleware/auth"
import { deleteObjectFromS3, getSignedUrlForKey, uploadBufferToS3 } from "../../services/s3.services"

const router = Router()

const hrLogsAccess = requireAppRole("main", ["admin"])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
})

const interviewFileKey = (workerUserId: string, fileName: string) => {
  const extension = path.extname(fileName).toLowerCase().slice(0, 16)
  return `worker-interviews/${workerUserId}/${crypto.randomBytes(16).toString("hex")}${extension}`
}

const withFileUrl = async (interview: Record<string, any>) => ({
  ...interview,
  file_url: interview.file_key
    ? await getSignedUrlForKey(interview.file_key, {
        expiresIn: 60 * 15,
        responseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(
          interview.original_file_name || "document",
        )}`,
      })
    : null,
})

router.post(
  "/",
  hrLogsAccess,
  upload.single("file"),
  async (req, res) => {
    const client = await pool.connect()
    let uploadedFileKey: string | null = null
    let committed = false

    try {
      const hrUserId = req.user!.id

      const {
        worker_user_id,
        matricule,
        notes_during_interview,
        interview_summary,
      } = req.body

      if (!worker_user_id) {
        return res.status(400).json({
          message: "worker_user_id est requis",
        })
      }

      if (!matricule?.trim()) {
        return res.status(400).json({
          message: "Le matricule est requis",
        })
      }

      await client.query("BEGIN")

      // Optional but recommended:
      // verify worker exists before inserting
      const workerResult = await client.query(
        `
        SELECT id
        FROM public.users
        WHERE id = $1
        `,
        [worker_user_id],
      )

      if (workerResult.rowCount === 0) {
        await client.query("ROLLBACK")

        return res.status(404).json({
          message: "Travailleur introuvable",
        })
      }

      let fileKey: string | null = null
      let originalFileName: string | null = null

      if (req.file) {
        originalFileName = req.file.originalname

        uploadedFileKey = interviewFileKey(String(worker_user_id), req.file.originalname)
        await uploadBufferToS3({
          key: uploadedFileKey,
          buffer: req.file.buffer,
          contentType: req.file.mimetype || "application/octet-stream",
        })
        fileKey = uploadedFileKey
      }

      const result = await client.query(
        `
        INSERT INTO foreign_workers_schedule.worker_interviews (
          hr_user_id,
          worker_user_id,
          matricule,
          notes_during_interview,
          interview_summary,
          file_key,
          original_file_name
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        )
        RETURNING *
        `,
        [
          hrUserId,
          worker_user_id,
          matricule.trim(),
          notes_during_interview?.trim() || null,
          interview_summary?.trim() || null,
          fileKey,
          originalFileName,
        ],
      )

      const interview = await withFileUrl(result.rows[0])
      await client.query("COMMIT")
      committed = true

      return res.status(201).json({
        message: "Entretien enregistré",
        interview,
      })
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK")
        if (uploadedFileKey) {
          await deleteObjectFromS3(uploadedFileKey).catch((cleanupError) =>
            console.error("Error cleaning up worker interview file:", cleanupError),
          )
        }
      }

      console.error("Error creating worker interview:", error)

      return res.status(500).json({
        message: "Erreur lors de l'enregistrement de l'entretien",
      })
    } finally {
      client.release()
    }
  },
)


router.get(
  "/",
  hrLogsAccess,
  async (req, res) => {
    try {
      const hrUserId = req.user!.id

      const result = await pool.query(
        `
        SELECT
          wi.id,
          wi.hr_user_id,
          wi.worker_user_id,
          wi.matricule,
          wi.interview_date,
          wi.notes_during_interview,
          wi.interview_summary,
          wi.file_key,
          wi.original_file_name,
          wi.status,
          wi.category,
          wi.other_category,
          wi.completed_at,
          wi.created_at,
          wi.updated_at,

          CONCAT(
            COALESCE(worker.surname, ''),
            ' ',
            COALESCE(worker.name, '')
          ) AS worker_name,

          CONCAT(
            COALESCE(hr.surname, ''),
            ' ',
            COALESCE(hr.name, '')
          ) AS hr_name

        FROM foreign_workers_schedule.worker_interviews wi

        LEFT JOIN public.users worker
          ON worker.id = wi.worker_user_id

        LEFT JOIN public.users hr
          ON hr.id = wi.hr_user_id

        WHERE
          wi.status = 'completed'
          OR (
            wi.status = 'draft'
            AND wi.hr_user_id = $1
          )
          AND wi.deleted_at IS NULL

        ORDER BY
          CASE
            WHEN wi.status = 'draft' THEN 0
            ELSE 1
          END,
          wi.updated_at DESC
        `,
        [hrUserId],
      )

      return res.json(
        await Promise.all(
          result.rows.map(withFileUrl),
        ),
      )
    } catch (error) {
      console.error(
        "Error fetching worker interviews:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors du chargement des entretiens",
      })
    }
  },
)


router.get(
  "/:id",
  hrLogsAccess,
  async (req, res) => {
    try {
      const { id } = req.params
      const hrUserId = req.user!.id

      const result = await pool.query(
        `
        SELECT
          wi.id,
          wi.hr_user_id,
          wi.worker_user_id,
          wi.matricule,
          wi.interview_date,
          wi.notes_during_interview,
          wi.interview_summary,
          wi.file_key,
          wi.original_file_name,
          wi.status,
          wi.completed_at,
          wi.created_at,
          wi.updated_at,

          CONCAT(
            COALESCE(worker.surname, ''),
            ' ',
            COALESCE(worker.name, '')
          ) AS worker_name,

          CONCAT(
            COALESCE(hr.surname, ''),
            ' ',
            COALESCE(hr.name, '')
          ) AS hr_name

        FROM foreign_workers_schedule.worker_interviews wi

        LEFT JOIN public.users worker
          ON worker.id = wi.worker_user_id

        LEFT JOIN public.users hr
          ON hr.id = wi.hr_user_id

       WHERE wi.id = $1
  AND wi.deleted_at IS NULL
  AND (
    wi.status = 'completed'
    OR (
      wi.status = 'draft'
      AND wi.hr_user_id = $2
    )
  )
        `,
        [id, hrUserId],
      )

      if (result.rowCount === 0) {
        return res.status(404).json({
          message: "Entretien introuvable",
        })
      }

      return res.json(
        await withFileUrl(result.rows[0]),
      )
    } catch (error) {
      console.error(
        "Error fetching worker interview:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors du chargement de l'entretien",
      })
    }
  },
)


router.patch(
  "/:id",
  hrLogsAccess,
  upload.single("file"),
  async (req, res) => {
    const client = await pool.connect()
    let uploadedFileKey: string | null = null
    let committed = false

    try {
      const { id } = req.params

      const {
        worker_user_id,
        matricule,
        notes_during_interview,
        interview_summary,
      } = req.body

      await client.query("BEGIN")

      const existingResult = await client.query(
        `
        SELECT *
        FROM foreign_workers_schedule.worker_interviews
        WHERE id = $1
        FOR UPDATE
        `,
        [id],
      )

      if (existingResult.rowCount === 0) {
        await client.query("ROLLBACK")

        return res.status(404).json({
          message: "Entretien introuvable",
        })
      }

      const existing = existingResult.rows[0]

      let fileKey = existing.file_key
      let originalFileName = existing.original_file_name

      if (req.file) {
        uploadedFileKey = interviewFileKey(
          String(worker_user_id || existing.worker_user_id),
          req.file.originalname,
        )
        await uploadBufferToS3({
          key: uploadedFileKey,
          buffer: req.file.buffer,
          contentType: req.file.mimetype || "application/octet-stream",
        })

        fileKey = uploadedFileKey
        originalFileName = req.file.originalname
      }

      const result = await client.query(
        `
        UPDATE foreign_workers_schedule.worker_interviews

        SET
          worker_user_id = COALESCE($1, worker_user_id),

          matricule = COALESCE(
            NULLIF($2, ''),
            matricule
          ),

          notes_during_interview = $3,

          interview_summary = $4,

          file_key = $5,

          original_file_name = $6,

          updated_at = NOW()

        WHERE id = $7

        RETURNING *
        `,
        [
          worker_user_id || null,
          matricule?.trim() || null,
          notes_during_interview ?? existing.notes_during_interview,
          interview_summary ?? existing.interview_summary,
          fileKey,
          originalFileName,
          id,
        ],
      )

      const interview = await withFileUrl(result.rows[0])
      await client.query("COMMIT")
      committed = true

      if (uploadedFileKey && existing.file_key) {
        await deleteObjectFromS3(existing.file_key).catch((cleanupError) =>
          console.error("Error deleting replaced worker interview file:", cleanupError),
        )
      }

      return res.json({
        message: "Entretien mis à jour",
        interview,
      })
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK")
        if (uploadedFileKey) {
          await deleteObjectFromS3(uploadedFileKey).catch((cleanupError) =>
            console.error("Error cleaning up worker interview file:", cleanupError),
          )
        }
      }

      console.error("Error updating worker interview:", error)

      return res.status(500).json({
        message: "Erreur lors de la mise à jour de l'entretien",
      })
    } finally {
      client.release()
    }
  },
)



router.post(
  "/draft",
  hrLogsAccess,
  async (req, res) => {
    try {
      const hrUserId = req.user!.id

      const {
        worker_user_id,
        matricule,
        interview_date,
      } = req.body

      const result = await pool.query(
        `
        INSERT INTO foreign_workers_schedule.worker_interviews (
          hr_user_id,
          worker_user_id,
          matricule,
          interview_date,
          status
        )
        VALUES ($1, $2, $3, $4, 'draft')
        RETURNING *
        `,
        [
          hrUserId,
          worker_user_id,
          matricule,
          interview_date,
        ],
      )

      return res.status(201).json(result.rows[0])
    } catch (error) {
      console.error(error)

      return res.status(500).json({
        message: "Erreur lors de la création du brouillon",
      })
    }
  },
)



router.patch(
  "/:id/draft",
  hrLogsAccess,
  async (req, res) => {
    try {
      const hrUserId = req.user!.id
      const { id } = req.params

      const {
        worker_user_id,
        matricule,
        interview_date,
        notes_during_interview,
        interview_summary,
      } = req.body

      const result = await pool.query(
        `
        UPDATE foreign_workers_schedule.worker_interviews
        SET
          worker_user_id = COALESCE($1, worker_user_id),
          matricule = COALESCE($2, matricule),
          interview_date = COALESCE($3, interview_date),
          notes_during_interview = COALESCE($4, notes_during_interview),
          interview_summary = COALESCE($5, interview_summary),
          updated_at = NOW()
        WHERE id = $6
          AND hr_user_id = $7
          AND status = 'draft'
          AND deleted_at IS NULL
        RETURNING *
        `,
        [
          worker_user_id,
          matricule,
          interview_date,
          notes_during_interview,
          interview_summary,
          id,
          hrUserId,
        ],
      )

      if (result.rowCount === 0) {
        return res.status(404).json({
          message: "Brouillon introuvable",
        })
      }

      return res.json(result.rows[0])
    } catch (error) {
      console.error(error)

      return res.status(500).json({
        message: "Erreur lors de la sauvegarde du brouillon",
      })
    }
  },
)


router.patch(
  "/:id/complete",
  hrLogsAccess,
  async (req, res) => {
    try {
      const hrUserId = req.user!.id
      const { id } = req.params

      const result = await pool.query(
        `
        UPDATE foreign_workers_schedule.worker_interviews
        SET
          status = 'completed',
          completed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
          AND hr_user_id = $2
          AND status = 'draft'
          AND deleted_at IS NULL
        RETURNING *
        `,
        [id, hrUserId],
      )

      if (result.rowCount === 0) {
        return res.status(404).json({
          message: "Brouillon introuvable",
        })
      }

      return res.json(result.rows[0])
    } catch (error) {
      console.error(error)

      return res.status(500).json({
        message: "Erreur lors de la finalisation de l'entretien",
      })
    }
  },
)

router.delete(
  "/:id/draft",
  hrLogsAccess,
  async (req, res) => {
    try {
      const hrUserId = req.user!.id
      const { id } = req.params

      const result = await pool.query(
        `
        UPDATE foreign_workers_schedule.worker_interviews
        SET
          deleted_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
          AND hr_user_id = $2
          AND status = 'draft'
          AND deleted_at IS NULL
        RETURNING *
        `,
        [id, hrUserId],
      )

      if (result.rowCount === 0) {
        return res.status(404).json({
          message: "Brouillon introuvable",
        })
      }

      return res.json({
        message: "Brouillon supprimé",
        interview: result.rows[0],
      })
    } catch (error) {
      console.error(
        "Error soft deleting worker interview draft:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors de la suppression du brouillon",
      })
    }
  },
)

router.patch(
  "/:id/draft/restore",
  hrLogsAccess,
  async (req, res) => {
    try {
      const hrUserId = req.user!.id
      const { id } = req.params

      const result = await pool.query(
        `
        UPDATE foreign_workers_schedule.worker_interviews
        SET
          deleted_at = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND hr_user_id = $2
          AND status = 'draft'
          AND deleted_at IS NOT NULL
        RETURNING *
        `,
        [id, hrUserId],
      )

      if (result.rowCount === 0) {
        return res.status(404).json({
          message: "Brouillon supprimé introuvable",
        })
      }

      return res.json({
        message: "Brouillon restauré",
        interview: result.rows[0],
      })
    } catch (error) {
      console.error(
        "Error restoring worker interview draft:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors de la restauration du brouillon",
      })
    }
  },
)

export default router
