

import { Router } from "express"
import multer from "multer"

import { pool } from "../../db"
import { requireAppRole } from "../../middleware/auth"
// import { uploadFileToS3, deleteFileFromS3 } from "../services/s3"

const router = Router()

const hrLogsAccess = requireAppRole("main", ["admin"])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
})

router.post(
  "/",
  hrLogsAccess,
  upload.single("file"),
  async (req, res) => {
    const client = await pool.connect()

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

        /*
        const uploadedFile = await uploadFileToS3({
          buffer: req.file.buffer,
          mimeType: req.file.mimetype,
          fileName: req.file.originalname,
          folder: `worker-interviews/${worker_user_id}`,
        })

        fileKey = uploadedFile.key
        */

        // Temporary until your S3 helper is connected
        fileKey = null
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

      await client.query("COMMIT")

      return res.status(201).json({
        message: "Entretien enregistré",
        interview: result.rows[0],
      })
    } catch (error) {
      await client.query("ROLLBACK")

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
      const result = await pool.query(
        `
        SELECT
          wi.id,
          wi.hr_user_id,
          wi.worker_user_id,
          wi.matricule,
          wi.notes_during_interview,
          wi.interview_summary,
          wi.file_key,
          wi.original_file_name,
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

        ORDER BY wi.created_at DESC
        `,
      )

      return res.json(result.rows)
    } catch (error) {
      console.error("Error fetching worker interviews:", error)

      return res.status(500).json({
        message: "Erreur lors du chargement des entretiens",
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

      const result = await pool.query(
        `
        SELECT
          wi.id,
          wi.hr_user_id,
          wi.worker_user_id,
          wi.matricule,
          wi.notes_during_interview,
          wi.interview_summary,
          wi.file_key,
          wi.original_file_name,
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
        `,
        [id],
      )

      if (result.rowCount === 0) {
        return res.status(404).json({
          message: "Entretien introuvable",
        })
      }

      return res.json(result.rows[0])
    } catch (error) {
      console.error("Error fetching worker interview:", error)

      return res.status(500).json({
        message: "Erreur lors du chargement de l'entretien",
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
        /*
        if (existing.file_key) {
          await deleteFileFromS3(existing.file_key)
        }

        const uploadedFile = await uploadFileToS3({
          buffer: req.file.buffer,
          mimeType: req.file.mimetype,
          fileName: req.file.originalname,
          folder: `worker-interviews/${
            worker_user_id || existing.worker_user_id
          }`,
        })

        fileKey = uploadedFile.key
        */

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

      await client.query("COMMIT")

      return res.json({
        message: "Entretien mis à jour",
        interview: result.rows[0],
      })
    } catch (error) {
      await client.query("ROLLBACK")

      console.error("Error updating worker interview:", error)

      return res.status(500).json({
        message: "Erreur lors de la mise à jour de l'entretien",
      })
    } finally {
      client.release()
    }
  },
)

export default router
