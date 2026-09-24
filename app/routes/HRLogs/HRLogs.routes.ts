import crypto from "crypto"
import { Router } from "express"
import multer from "multer"
import path from "path"

import { pool } from "../../db"
import { requireAppRole } from "../../middleware/auth"
import {
  deleteObjectFromS3,
  getSignedUrlForKey,
  uploadBufferToS3,
} from "../../services/s3.services"

const router = Router()

const hrLogsAccess = requireAppRole("main", ["admin"])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
})

const parseNeedsAgreement = (value: unknown) =>
  value === true || value === "true"

const normalizeAgreementTerms = (value: unknown) =>
  typeof value === "string"
    ? value.trim() || null
    : null

const withAgreementData = async (
  row: Record<string, any>,
) => {
  const interview = await withFileUrls(row)

  let signatureUrl: string | null = null

  if (row.agreement_signature_s3_key) {
    signatureUrl = await getSignedUrlForKey(
      row.agreement_signature_s3_key,
      {
        expiresIn: 60 * 15,
        responseContentDisposition:
          `inline; filename="signature.png"`,
      },
    )
  }

  return {
    ...interview,

    agreement:
      row.needs_agreement &&
      row.agreement_id
      ? {
          id: row.agreement_id,
          interview_id: row.id,

          agreement_terms:
            row.agreement_terms,

          status:
            row.agreement_status,

          signature_s3_key:
            row.agreement_signature_s3_key,

          signature_url:
            signatureUrl,

          signed_at:
            row.agreement_signed_at,

          has_accepted_terms:
            row.agreement_has_accepted_terms,

          created_at:
            row.agreement_created_at,

          updated_at:
            row.agreement_updated_at,
        }
      : null,
  }
}

const interviewFileKey = (
  workerUserId: string,
  fileName: string,
) => {
  const extension = path
    .extname(fileName)
    .toLowerCase()
    .slice(0, 16)

  return `worker-interviews/${workerUserId}/${crypto
    .randomBytes(16)
    .toString("hex")}${extension}`
}


const agreementSignatureKey = (
  workerUserId: string,
  interviewId: string,
  fileName: string,
) => {
  const extension =
    path.extname(fileName).toLowerCase().slice(0, 16) ||
    ".png"

  return `worker-interview-agreements/${workerUserId}/${interviewId}/${crypto
    .randomBytes(16)
    .toString("hex")}${extension}`
}

const withFileUrls = async (
  interview: Record<string, any>,
) => {
  const result = await pool.query(
    `
    SELECT id, file_key, original_file_name, mime_type, file_size, created_at
    FROM foreign_workers_schedule.worker_interview_files
    WHERE interview_id = $1
    ORDER BY created_at ASC, id ASC
    `,
    [interview.id],
  )

  const files = await Promise.all(
    result.rows.map(async (file) => {
      const fileName = file.original_file_name || "document"
      const [previewUrl, downloadUrl] = await Promise.all([
        getSignedUrlForKey(file.file_key, {
          expiresIn: 60 * 15,
          responseContentDisposition:
            `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        }),
        getSignedUrlForKey(file.file_key, {
          expiresIn: 60 * 15,
          responseContentDisposition:
            `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        }),
      ])

      return {
        ...file,
        preview_url: previewUrl,
        download_url: downloadUrl,
      }
    }),
  )

  const primaryFile = files[0] || null

  return {
    ...interview,
    files,
    file_key: primaryFile?.file_key ?? null,
    original_file_name: primaryFile?.original_file_name ?? null,
    preview_url: primaryFile?.preview_url ?? null,
    download_url: primaryFile?.download_url ?? null,
  }
}

/* =========================================================
   CREATE COMPLETED INTERVIEW
========================================================= */

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
        interview_date,
        notes_during_interview,
        interview_summary,
        category,
        other_category,

        needs_agreement,
        agreement_terms,
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

      if (!interview_date) {
        return res.status(400).json({
          message: "La date de l'entretien est requise",
        })
      }

      if (!category?.trim()) {
        return res.status(400).json({
          message: "La catégorie est requise",
        })
      }

      if (
        category === "other" &&
        !other_category?.trim()
      ) {
        return res.status(400).json({
          message: "Veuillez préciser la catégorie",
        })
      }

      const needsAgreement =
        parseNeedsAgreement(needs_agreement)

      const normalizedAgreementTerms =
        normalizeAgreementTerms(agreement_terms)

      if (
        needsAgreement &&
        !normalizedAgreementTerms
      ) {
        return res.status(400).json({
          message:
            "Les termes de l'entente sont requis",
        })
      }

      await client.query("BEGIN")

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
        originalFileName =
          req.file.originalname

        uploadedFileKey =
          interviewFileKey(
            String(worker_user_id),
            req.file.originalname,
          )

        await uploadBufferToS3({
          key: uploadedFileKey,
          buffer: req.file.buffer,
          contentType:
            req.file.mimetype ||
            "application/octet-stream",
        })

        fileKey = uploadedFileKey
      }

      const interviewResult =
        await client.query(
          `
          INSERT INTO foreign_workers_schedule.worker_interviews (
            hr_user_id,
            worker_user_id,
            matricule,
            interview_date,
            notes_during_interview,
            interview_summary,
            category,
            other_category,
            file_key,
            original_file_name,
            status,
            completed_at,
            needs_agreement
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            'completed',
            NOW(),
            $11
          )
          RETURNING *
          `,
          [
            hrUserId,
            worker_user_id,
            matricule.trim(),
            interview_date,

            notes_during_interview?.trim() ||
              null,

            interview_summary?.trim() ||
              null,

            category.trim(),

            category === "other"
              ? other_category?.trim() || null
              : null,

            fileKey,
            originalFileName,
            needsAgreement,
          ],
        )

      const interview =
        interviewResult.rows[0]

      let agreement = null

      if (needsAgreement) {
        const agreementResult =
          await client.query(
            `
            INSERT INTO foreign_workers_schedule.worker_interview_agreements (
              interview_id,
              agreement_terms,
              status,
              signature_s3_key,
              signed_at,
              has_accepted_terms
            )
            VALUES (
              $1,
              $2,
              'pending_signature',
              NULL,
              NULL,
              FALSE
            )
            RETURNING *
            `,
            [
              interview.id,
              normalizedAgreementTerms,
            ],
          )

        agreement =
          agreementResult.rows[0]
      }

      await client.query("COMMIT")
      committed = true

      const interviewWithUrls =
        await withFileUrls(
          interview,
        )

      return res.status(201).json({
        message: "Entretien enregistré",
        interview: interviewWithUrls,
        agreement,
      })
    } catch (error) {
      if (!committed) {
        await client
          .query("ROLLBACK")
          .catch(() => undefined)

        if (uploadedFileKey) {
          await deleteObjectFromS3(
            uploadedFileKey,
          ).catch((cleanupError) =>
            console.error(
              "Error cleaning up worker interview file:",
              cleanupError,
            ),
          )
        }
      }

      console.error(
        "Error creating worker interview:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors de l'enregistrement de l'entretien",
      })
    } finally {
      client.release()
    }
  },
)

/* =========================================================
   GET INTERVIEWS

   Completed:
   visible to all HR users.

   Drafts:
   only visible to their creator.

   Soft-deleted rows:
   hidden.
========================================================= */

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

          wi.needs_agreement,

          wi.completed_at,
          wi.deleted_at,
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
          ) AS hr_name,

          agreement.id
            AS agreement_id,

          agreement.agreement_terms
            AS agreement_terms,

          agreement.status
            AS agreement_status,

          agreement.signature_s3_key
            AS agreement_signature_s3_key,

          agreement.signed_at
            AS agreement_signed_at,

          agreement.has_accepted_terms
            AS agreement_has_accepted_terms,

          agreement.created_at
            AS agreement_created_at,

          agreement.updated_at
            AS agreement_updated_at

        FROM foreign_workers_schedule.worker_interviews wi

        LEFT JOIN public.users worker
          ON worker.id = wi.worker_user_id

        LEFT JOIN public.users hr
          ON hr.id = wi.hr_user_id

        LEFT JOIN foreign_workers_schedule.worker_interview_agreements agreement
          ON agreement.interview_id = wi.id

        WHERE
          wi.deleted_at IS NULL
          AND (
            wi.status = 'completed'

            OR (
              wi.status = 'draft'
              AND wi.hr_user_id = $1
            )
          )

        ORDER BY
          CASE
            WHEN wi.status = 'draft'
              THEN 0
            ELSE 1
          END,

          wi.updated_at DESC
        `,
        [hrUserId],
      )

      const interviews =
        await Promise.all(
          result.rows.map(
            withAgreementData,
          ),
        )

      return res.json(interviews)
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

/* =========================================================
   GET ONE INTERVIEW
========================================================= */

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
          wi.category,
          wi.other_category,

          wi.needs_agreement,

          wi.completed_at,
          wi.deleted_at,
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
          ) AS hr_name,

          agreement.id
            AS agreement_id,

          agreement.agreement_terms
            AS agreement_terms,

          agreement.status
            AS agreement_status,

          agreement.signature_s3_key
            AS agreement_signature_s3_key,

          agreement.signed_at
            AS agreement_signed_at,

          agreement.has_accepted_terms
            AS agreement_has_accepted_terms,

          agreement.created_at
            AS agreement_created_at,

          agreement.updated_at
            AS agreement_updated_at

        FROM foreign_workers_schedule.worker_interviews wi

        LEFT JOIN public.users worker
          ON worker.id =
            wi.worker_user_id

        LEFT JOIN public.users hr
          ON hr.id =
            wi.hr_user_id

        LEFT JOIN foreign_workers_schedule.worker_interview_agreements agreement
          ON agreement.interview_id = wi.id

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
          message:
            "Entretien introuvable",
        })
      }

      const interview =
        await withAgreementData(
          result.rows[0],
        )

      return res.json(interview)
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

/* =========================================================
   UPDATE INTERVIEW / ATTACH FILE
========================================================= */

router.patch(
  "/:id",
  hrLogsAccess,
  upload.single("file"),
  async (req, res) => {
    const client = await pool.connect()

    let uploadedFileKey: string | null =
      null

    let committed = false

    try {
      const { id } = req.params
      const hrUserId = req.user!.id

      const {
        worker_user_id,
        matricule,
        interview_date,
        notes_during_interview,
        interview_summary,
        category,
        other_category,

        needs_agreement,
        agreement_terms,
      } = req.body

      await client.query("BEGIN")

      const existingResult =
        await client.query(
          `
          SELECT *
          FROM foreign_workers_schedule.worker_interviews

          WHERE id = $1
            AND deleted_at IS NULL

            AND (
              status = 'completed'

              OR (
                status = 'draft'
                AND hr_user_id = $2
              )
            )

          FOR UPDATE
          `,
          [id, hrUserId],
        )

      if (
        existingResult.rowCount === 0
      ) {
        await client.query("ROLLBACK")

        return res.status(404).json({
          message: "Entretien introuvable",
        })
      }

      const existing =
        existingResult.rows[0]

      const existingAgreementResult =
        await client.query(
          `
          SELECT *
          FROM foreign_workers_schedule.worker_interview_agreements
          WHERE interview_id = $1
          FOR UPDATE
          `,
          [id],
        )

      const existingAgreement =
        existingAgreementResult.rows[0] || null

      let fileKey =
        existing.file_key

      let originalFileName =
        existing.original_file_name

      if (req.file) {
        uploadedFileKey =
          interviewFileKey(
            String(
              worker_user_id ||
                existing.worker_user_id,
            ),
            req.file.originalname,
          )

        await uploadBufferToS3({
          key: uploadedFileKey,
          buffer: req.file.buffer,

          contentType:
            req.file.mimetype ||
            "application/octet-stream",
        })

        fileKey = uploadedFileKey

        originalFileName =
          req.file.originalname
      }

      const nextCategory =
        category !== undefined
          ? category.trim() || null
          : existing.category

      const nextOtherCategory =
        nextCategory === "other"
          ? other_category !== undefined
            ? other_category.trim() || null
            : existing.other_category
          : null

      const nextNeedsAgreement =
        needs_agreement === undefined
          ? Boolean(existing.needs_agreement)
          : parseNeedsAgreement(needs_agreement)

      const nextAgreementTerms =
        agreement_terms === undefined
          ? normalizeAgreementTerms(
              existingAgreement?.agreement_terms,
            )
          : normalizeAgreementTerms(
              agreement_terms,
            )

      if (
        nextCategory === "other" &&
        !nextOtherCategory
      ) {
        await client.query("ROLLBACK")

        if (uploadedFileKey) {
          await deleteObjectFromS3(
            uploadedFileKey,
          ).catch(() => undefined)
        }

        return res.status(400).json({
          message:
            "Veuillez préciser la catégorie",
        })
      }

      if (
        nextNeedsAgreement &&
        !nextAgreementTerms
      ) {
        await client.query("ROLLBACK")

        if (uploadedFileKey) {
          await deleteObjectFromS3(
            uploadedFileKey,
          ).catch(() => undefined)
        }

        return res.status(400).json({
          message:
            "Les termes de l'entente sont requis",
        })
      }

      const result = await client.query(
        `
        UPDATE foreign_workers_schedule.worker_interviews

        SET
          worker_user_id =
            COALESCE(
              $1,
              worker_user_id
            ),

          matricule =
            COALESCE(
              NULLIF($2, ''),
              matricule
            ),

          interview_date =
            COALESCE(
              $3,
              interview_date
            ),

          notes_during_interview =
            COALESCE(
              $4,
              notes_during_interview
            ),

          interview_summary =
            COALESCE(
              $5,
              interview_summary
            ),

          category = $6,

          other_category = $7,

          file_key = $8,

          original_file_name = $9,

          updated_at = NOW(),

          needs_agreement = $10

        WHERE id = $11

        RETURNING *
        `,
        [
          worker_user_id || null,
          matricule?.trim() || null,
          interview_date || null,

          notes_during_interview ??
            existing.notes_during_interview,

          interview_summary ??
            existing.interview_summary,

          nextCategory,
          nextOtherCategory,

          fileKey,
          originalFileName,

          nextNeedsAgreement,
          id,
        ],
      )

      let agreement = nextNeedsAgreement
        ? existingAgreement
        : null

      if (
        nextNeedsAgreement &&
        existing.status === "completed"
      ) {
        if (existingAgreement) {
          const agreementResult =
            await client.query(
              `
              UPDATE foreign_workers_schedule.worker_interview_agreements
              SET
                agreement_terms = $1,
                updated_at = NOW()
              WHERE id = $2
              RETURNING *
              `,
              [
                nextAgreementTerms,
                existingAgreement.id,
              ],
            )

          agreement = agreementResult.rows[0]
        } else {
          const agreementResult =
            await client.query(
              `
              INSERT INTO foreign_workers_schedule.worker_interview_agreements (
                interview_id,
                agreement_terms,
                status,
                signature_s3_key,
                signed_at,
                has_accepted_terms
              )
              VALUES (
                $1,
                $2,
                'pending_signature',
                NULL,
                NULL,
                FALSE
              )
              RETURNING *
              `,
              [id, nextAgreementTerms],
            )

          agreement = agreementResult.rows[0]
        }
      }

      await client.query("COMMIT")
      committed = true

      if (
        uploadedFileKey &&
        existing.file_key
      ) {
        await deleteObjectFromS3(
          existing.file_key,
        ).catch((cleanupError) =>
          console.error(
            "Error deleting replaced worker interview file:",
            cleanupError,
          ),
        )
      }

      const interview =
        await withFileUrls(
          result.rows[0],
        )

      return res.json({
        message: "Entretien mis à jour",
        interview,
        agreement,
      })
    } catch (error) {
      if (!committed) {
        await client
          .query("ROLLBACK")
          .catch(() => undefined)

        if (uploadedFileKey) {
          await deleteObjectFromS3(
            uploadedFileKey,
          ).catch((cleanupError) =>
            console.error(
              "Error cleaning up worker interview file:",
              cleanupError,
            ),
          )
        }
      }

      console.error(
        "Error updating worker interview:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors de la mise à jour de l'entretien",
      })
    } finally {
      client.release()
    }
  },
)

/* =========================================================
   ADD INTERVIEW FILES
========================================================= */

router.post(
  "/:id/files",
  hrLogsAccess,
  upload.array("files", 10),
  async (req, res) => {
    const client = await pool.connect()
    const uploadedKeys: string[] = []
    let committed = false

    try {
      const { id } = req.params
      const hrUserId = req.user!.id
      const files = (req.files || []) as Express.Multer.File[]

      if (files.length === 0) {
        return res.status(400).json({
          message: "Au moins un fichier est requis",
        })
      }

      await client.query("BEGIN")

      const existingResult = await client.query(
        `
        SELECT *
        FROM foreign_workers_schedule.worker_interviews
        WHERE id = $1
          AND deleted_at IS NULL
          AND (
            status = 'completed'
            OR (status = 'draft' AND hr_user_id = $2)
          )
        FOR UPDATE
        `,
        [id, hrUserId],
      )

      if (existingResult.rowCount === 0) {
        await client.query("ROLLBACK")
        return res.status(404).json({ message: "Entretien introuvable" })
      }

      const existing = existingResult.rows[0]

      for (const file of files) {
        const fileKey = interviewFileKey(
          String(existing.worker_user_id),
          file.originalname,
        )

        await uploadBufferToS3({
          key: fileKey,
          buffer: file.buffer,
          contentType: file.mimetype || "application/octet-stream",
        })
        uploadedKeys.push(fileKey)

        await client.query(
          `
          INSERT INTO foreign_workers_schedule.worker_interview_files (
            interview_id,
            file_key,
            original_file_name,
            mime_type,
            file_size
          )
          VALUES ($1, $2, $3, $4, $5)
          `,
          [
            id,
            fileKey,
            file.originalname,
            file.mimetype || "application/octet-stream",
            file.size,
          ],
        )
      }

      if (!existing.file_key) {
        await client.query(
          `
          UPDATE foreign_workers_schedule.worker_interviews
          SET file_key = $1, original_file_name = $2, updated_at = NOW()
          WHERE id = $3
          `,
          [uploadedKeys[0], files[0].originalname, id],
        )
      } else {
        await client.query(
          `
          UPDATE foreign_workers_schedule.worker_interviews
          SET updated_at = NOW()
          WHERE id = $1
          `,
          [id],
        )
      }

      await client.query("COMMIT")
      committed = true

      const updatedResult = await pool.query(
        `SELECT * FROM foreign_workers_schedule.worker_interviews WHERE id = $1`,
        [id],
      )
      const interview = await withFileUrls(updatedResult.rows[0])

      return res.status(201).json({
        message: files.length === 1 ? "Fichier ajouté" : "Fichiers ajoutés",
        interview,
      })
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK").catch(() => undefined)
        await Promise.allSettled(uploadedKeys.map(deleteObjectFromS3))
      }

      console.error("Error adding worker interview files:", error)
      return res.status(500).json({
        message: "Erreur lors de l'ajout des fichiers",
      })
    } finally {
      client.release()
    }
  },
)

/* =========================================================
   DELETE ONE INTERVIEW FILE
========================================================= */

router.delete(
  "/:id/files/:fileId",
  hrLogsAccess,
  async (req, res) => {
    const client = await pool.connect()
    let committed = false

    try {
      const { id, fileId } = req.params
      const hrUserId = req.user!.id

      await client.query("BEGIN")

      const interviewResult = await client.query(
        `
        SELECT *
        FROM foreign_workers_schedule.worker_interviews
        WHERE id = $1
          AND deleted_at IS NULL
          AND (
            status = 'completed'
            OR (status = 'draft' AND hr_user_id = $2)
          )
        FOR UPDATE
        `,
        [id, hrUserId],
      )

      if (interviewResult.rowCount === 0) {
        await client.query("ROLLBACK")
        return res.status(404).json({ message: "Entretien introuvable" })
      }

      const fileResult = await client.query(
        `
        DELETE FROM foreign_workers_schedule.worker_interview_files
        WHERE id = $1 AND interview_id = $2
        RETURNING *
        `,
        [fileId, id],
      )

      if (fileResult.rowCount === 0) {
        await client.query("ROLLBACK")
        return res.status(404).json({ message: "Fichier introuvable" })
      }

      const deletedFile = fileResult.rows[0]
      const nextFileResult = await client.query(
        `
        SELECT file_key, original_file_name
        FROM foreign_workers_schedule.worker_interview_files
        WHERE interview_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        `,
        [id],
      )
      const nextFile = nextFileResult.rows[0] || null

      await client.query(
        `
        UPDATE foreign_workers_schedule.worker_interviews
        SET file_key = $1, original_file_name = $2, updated_at = NOW()
        WHERE id = $3
        `,
        [nextFile?.file_key ?? null, nextFile?.original_file_name ?? null, id],
      )

      await client.query("COMMIT")
      committed = true

      await deleteObjectFromS3(deletedFile.file_key).catch((cleanupError) =>
        console.error("Error deleting worker interview file from S3:", cleanupError),
      )

      const updatedResult = await pool.query(
        `SELECT * FROM foreign_workers_schedule.worker_interviews WHERE id = $1`,
        [id],
      )
      const interview = await withFileUrls(updatedResult.rows[0])

      return res.json({ message: "Fichier supprimé", interview })
    } catch (error) {
      if (!committed) {
        await client.query("ROLLBACK").catch(() => undefined)
      }

      console.error("Error deleting worker interview file:", error)
      return res.status(500).json({
        message: "Erreur lors de la suppression du fichier",
      })
    } finally {
      client.release()
    }
  },
)

/* =========================================================
   DELETE INTERVIEW FILE
========================================================= */

router.delete(
  "/:id/file",
  hrLogsAccess,
  async (req, res) => {
    const client = await pool.connect()
    let committed = false

    try {
      const { id } = req.params
      const hrUserId = req.user!.id

      await client.query("BEGIN")

      const existingResult =
        await client.query(
          `
          SELECT *
          FROM foreign_workers_schedule.worker_interviews

          WHERE id = $1
            AND deleted_at IS NULL

            AND (
              status = 'completed'

              OR (
                status = 'draft'
                AND hr_user_id = $2
              )
            )

          FOR UPDATE
          `,
          [id, hrUserId],
        )

      if (existingResult.rowCount === 0) {
        await client.query("ROLLBACK")

        return res.status(404).json({
          message: "Entretien introuvable",
        })
      }

      const filesResult = await client.query(
        `
        DELETE FROM foreign_workers_schedule.worker_interview_files
        WHERE interview_id = $1
        RETURNING file_key
        `,
        [id],
      )

      if (filesResult.rowCount === 0) {
        await client.query("ROLLBACK")

        return res.status(404).json({
          message:
            "Aucun fichier n'est associé à cet entretien",
        })
      }

      const result = await client.query(
        `
        UPDATE foreign_workers_schedule.worker_interviews

        SET
          file_key = NULL,
          original_file_name = NULL,
          updated_at = NOW()

        WHERE id = $1

        RETURNING *
        `,
        [id],
      )

      await client.query("COMMIT")
      committed = true

      await Promise.allSettled(
        filesResult.rows.map((file) => deleteObjectFromS3(file.file_key)),
      )

      const interview =
        await withFileUrls(
          result.rows[0],
        )

      return res.json({
        message: "Fichier supprimé",
        interview,
      })
    } catch (error) {
      if (!committed) {
        await client
          .query("ROLLBACK")
          .catch(() => undefined)
      }

      console.error(
        "Error deleting worker interview file:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors de la suppression du fichier",
      })
    } finally {
      client.release()
    }
  },
)

/* =========================================================
   CREATE DRAFT
========================================================= */

router.post(
  "/draft",
  hrLogsAccess,
  async (req, res) => {
    const client = await pool.connect()
    let committed = false

    try {
      const hrUserId = req.user!.id

      const {
        worker_user_id,
        matricule,
        interview_date,
        category,
        other_category,
        needs_agreement,
        agreement_terms,
      } = req.body

      if (!worker_user_id) {
        return res.status(400).json({
          message:
            "worker_user_id est requis",
        })
      }

      if (!matricule?.trim()) {
        return res.status(400).json({
          message:
            "Le matricule est requis",
        })
      }

      const needsAgreement =
        parseNeedsAgreement(needs_agreement)

      const normalizedAgreementTerms =
        normalizeAgreementTerms(agreement_terms)

      await client.query("BEGIN")

      const result = await client.query(
        `
        INSERT INTO foreign_workers_schedule.worker_interviews (
          hr_user_id,
          worker_user_id,
          matricule,
          interview_date,
          category,
          other_category,
          needs_agreement,
          status
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          'draft'
        )

        RETURNING *
        `,
        [
          hrUserId,
          worker_user_id,
          matricule.trim(),
          interview_date || null,
          category?.trim() || null,

          category === "other"
            ? other_category?.trim() ||
              null
            : null,

          needsAgreement,
        ],
      )

      let agreement = null

      if (
        needsAgreement &&
        normalizedAgreementTerms
      ) {
        const agreementResult =
          await client.query(
            `
            INSERT INTO foreign_workers_schedule.worker_interview_agreements (
              interview_id,
              agreement_terms,
              status,
              signature_s3_key,
              signed_at,
              has_accepted_terms
            )
            VALUES (
              $1,
              $2,
              'pending_signature',
              NULL,
              NULL,
              FALSE
            )
            RETURNING *
            `,
            [
              result.rows[0].id,
              normalizedAgreementTerms,
            ],
          )

        agreement = agreementResult.rows[0]
      }

      await client.query("COMMIT")
      committed = true

      const interview = await withFileUrls(
        result.rows[0],
      )

      return res.status(201).json({
        ...interview,
        agreement_terms:
          agreement?.agreement_terms ?? null,
        agreement,
      })
    } catch (error) {
      if (!committed) {
        await client
          .query("ROLLBACK")
          .catch(() => undefined)
      }

      console.error(
        "Error creating worker interview draft:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors de la création du brouillon",
      })
    } finally {
      client.release()
    }
  },
)

/* =========================================================
   SAVE DRAFT
========================================================= */

router.patch(
  "/:id/draft",
  hrLogsAccess,
  async (req, res) => {
    const client = await pool.connect()
    let committed = false

    try {
      const hrUserId = req.user!.id
      const { id } = req.params

      const {
        worker_user_id,
        matricule,
        interview_date,
        notes_during_interview,
        interview_summary,
        category,
        other_category,
        needs_agreement,
        agreement_terms,
      } = req.body

      const nextNeedsAgreement =
        needs_agreement === undefined
          ? null
          : parseNeedsAgreement(needs_agreement)

      const hasAgreementTerms =
        agreement_terms !== undefined

      const nextAgreementTerms =
        normalizeAgreementTerms(agreement_terms)

      await client.query("BEGIN")

      const result = await client.query(
        `
        UPDATE foreign_workers_schedule.worker_interviews

        SET
          worker_user_id =
            COALESCE(
              $1,
              worker_user_id
            ),

          matricule =
            COALESCE(
              $2,
              matricule
            ),

          interview_date =
            COALESCE(
              $3,
              interview_date
            ),

          notes_during_interview =
            COALESCE(
              $4,
              notes_during_interview
            ),

          interview_summary =
            COALESCE(
              $5,
              interview_summary
            ),

          category =
            COALESCE(
              $6,
              category
            ),

          other_category =
            CASE
              WHEN COALESCE(
                $6,
                category
              ) = 'other'
              THEN COALESCE(
                $7,
                other_category
              )

              ELSE NULL
            END,

          needs_agreement =
            COALESCE(
              $8,
              needs_agreement
            ),

          updated_at = NOW()

        WHERE id = $9
          AND hr_user_id = $10
          AND status = 'draft'
          AND deleted_at IS NULL

        RETURNING *
        `,
        [
          worker_user_id ?? null,
          matricule ?? null,
          interview_date ?? null,

          notes_during_interview ??
            null,

          interview_summary ??
            null,

          category ?? null,
          other_category ?? null,

          nextNeedsAgreement,
          id,
          hrUserId,
        ],
      )

      if (result.rowCount === 0) {
        await client.query("ROLLBACK")

        return res.status(404).json({
          message:
            "Brouillon introuvable",
        })
      }

      const existingAgreementResult =
        await client.query(
          `
          SELECT *
          FROM foreign_workers_schedule.worker_interview_agreements
          WHERE interview_id = $1
          FOR UPDATE
          `,
          [id],
        )

      const existingAgreement =
        existingAgreementResult.rows[0] || null

      const needsAgreement = Boolean(
        result.rows[0].needs_agreement,
      )

      const effectiveAgreementTerms =
        hasAgreementTerms
          ? nextAgreementTerms
          : normalizeAgreementTerms(
              existingAgreement?.agreement_terms,
            )

      let agreement = existingAgreement

      if (
        !needsAgreement ||
        (hasAgreementTerms &&
          !effectiveAgreementTerms)
      ) {
        if (existingAgreement) {
          await client.query(
            `
            DELETE FROM foreign_workers_schedule.worker_interview_agreements
            WHERE id = $1
            `,
            [existingAgreement.id],
          )
        }

        agreement = null
      } else if (effectiveAgreementTerms) {
        if (existingAgreement) {
          const agreementResult =
            await client.query(
              `
              UPDATE foreign_workers_schedule.worker_interview_agreements
              SET
                agreement_terms = $1,
                updated_at = NOW()
              WHERE id = $2
              RETURNING *
              `,
              [
                effectiveAgreementTerms,
                existingAgreement.id,
              ],
            )

          agreement = agreementResult.rows[0]
        } else {
          const agreementResult =
            await client.query(
              `
              INSERT INTO foreign_workers_schedule.worker_interview_agreements (
                interview_id,
                agreement_terms,
                status,
                signature_s3_key,
                signed_at,
                has_accepted_terms
              )
              VALUES (
                $1,
                $2,
                'pending_signature',
                NULL,
                NULL,
                FALSE
              )
              RETURNING *
              `,
              [id, effectiveAgreementTerms],
            )

          agreement = agreementResult.rows[0]
        }
      }

      await client.query("COMMIT")
      committed = true

      const interview = await withFileUrls(
        result.rows[0],
      )

      return res.json({
        ...interview,
        agreement_terms:
          agreement?.agreement_terms ?? null,
        agreement,
      })
    } catch (error) {
      if (!committed) {
        await client
          .query("ROLLBACK")
          .catch(() => undefined)
      }

      console.error(
        "Error saving worker interview draft:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors de la sauvegarde du brouillon",
      })
    } finally {
      client.release()
    }
  },
)

/* =========================================================
   COMPLETE DRAFT
========================================================= */

router.patch(
  "/:id/complete",
  hrLogsAccess,
  async (req, res) => {
    const client = await pool.connect()

    try {
      const hrUserId = req.user!.id
      const { id } = req.params

      await client.query("BEGIN")

      /*
       * I validate the final record here rather than
       * trusting that the UI already did it.
       */

      const existingResult =
        await client.query(
          `
          SELECT *
          FROM foreign_workers_schedule.worker_interviews

          WHERE id = $1
            AND hr_user_id = $2
            AND status = 'draft'
            AND deleted_at IS NULL

          FOR UPDATE
          `,
          [id, hrUserId],
        )

      if (
        existingResult.rowCount === 0
      ) {
        await client.query("ROLLBACK")

        return res.status(404).json({
          message:
            "Brouillon introuvable",
        })
      }

      const existing =
        existingResult.rows[0]

      const existingAgreementResult =
        await client.query(
          `
          SELECT *
          FROM foreign_workers_schedule.worker_interview_agreements
          WHERE interview_id = $1
          FOR UPDATE
          `,
          [id],
        )

      const existingAgreement =
        existingAgreementResult.rows[0] || null

      if (!existing.worker_user_id) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message:
            "Un travailleur doit être sélectionné",
        })
      }

      if (!existing.matricule) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message:
            "Le matricule est requis",
        })
      }

      if (!existing.interview_date) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message:
            "La date de l'entretien est requise",
        })
      }

      if (!existing.category) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message:
            "La catégorie est requise",
        })
      }

      if (
        existing.category === "other" &&
        !existing.other_category
      ) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message:
            "Veuillez préciser la catégorie",
        })
      }

      if (
        existing.needs_agreement &&
        !normalizeAgreementTerms(
          existingAgreement?.agreement_terms,
        )
      ) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message:
            "Les termes de l'entente sont requis",
        })
      }

      const result = await client.query(
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

      const agreement = existing.needs_agreement
        ? existingAgreement
        : null

      await client.query("COMMIT")

      const interview =
        await withFileUrls(
          result.rows[0],
        )

      return res.json({
        message:
          "Entretien finalisé",

        interview,
        agreement,
      })
    } catch (error) {
      await client
        .query("ROLLBACK")
        .catch(() => undefined)

      console.error(
        "Error completing worker interview:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors de la finalisation de l'entretien",
      })
    } finally {
      client.release()
    }
  },
)

/* =========================================================
   SIGN INTERVIEW AGREEMENT
========================================================= */

router.post(
  "/:id/agreement/sign",
  hrLogsAccess,
  upload.single("signature"),
  async (req, res) => {
    const client = await pool.connect()

    let uploadedSignatureKey: string | null = null
    let committed = false

    try {
      const { id } = req.params

      const hasAcceptedTerms =
        req.body.has_accepted_terms === true ||
        req.body.has_accepted_terms === "true"

      if (!hasAcceptedTerms) {
        return res.status(400).json({
          message:
            "Les termes de l'entente doivent être acceptés avant la signature",
        })
      }

      if (!req.file) {
        return res.status(400).json({
          message: "La signature est requise",
        })
      }

      if (!req.file.mimetype.startsWith("image/")) {
        return res.status(400).json({
          message: "Le fichier de signature doit être une image",
        })
      }

      await client.query("BEGIN")

      /*
       * Lock both the interview and its agreement so two
       * simultaneous signature requests cannot overwrite
       * each other unpredictably.
       */
      const result = await client.query(
        `
        SELECT
          wi.id,
          wi.worker_user_id,
          wi.needs_agreement,

          agreement.id AS agreement_id,
          agreement.status AS agreement_status,
          agreement.signature_s3_key,
          agreement.signed_at,
          agreement.has_accepted_terms

        FROM foreign_workers_schedule.worker_interviews wi

        LEFT JOIN foreign_workers_schedule.worker_interview_agreements agreement
          ON agreement.interview_id = wi.id

        WHERE wi.id = $1
          AND agreement.interview_id IS NOT NULL
          AND wi.deleted_at IS NULL

        FOR UPDATE OF wi, agreement
        `,
        [id],
      )

      if (result.rowCount === 0) {
        await client.query("ROLLBACK")

        return res.status(404).json({
          message: "Entretien introuvable",
        })
      }

      const interview = result.rows[0]

      if (!interview.needs_agreement) {
        await client.query("ROLLBACK")

        return res.status(400).json({
          message:
            "Cet entretien ne nécessite aucune entente",
        })
      }

      if (!interview.agreement_id) {
        await client.query("ROLLBACK")

        return res.status(404).json({
          message:
            "Aucune entente n'est associée à cet entretien",
        })
      }

      const previousSignatureKey =
        interview.signature_s3_key as string | null

      uploadedSignatureKey =
        agreementSignatureKey(
          String(interview.worker_user_id),
          String(interview.id),
          req.file.originalname || "signature.png",
        )

      await uploadBufferToS3({
        key: uploadedSignatureKey,
        buffer: req.file.buffer,
        contentType:
          req.file.mimetype || "image/png",
      })

      const agreementResult = await client.query(
        `
        UPDATE foreign_workers_schedule.worker_interview_agreements

        SET
          status = 'signed',
          signature_s3_key = $1,
          has_accepted_terms = TRUE,
          signed_at = NOW(),
          updated_at = NOW()

        WHERE id = $2

        RETURNING *
        `,
        [
          uploadedSignatureKey,
          interview.agreement_id,
        ],
      )

      await client.query("COMMIT")
      committed = true

      /*
       * Delete the previous signature only after the database
       * transaction succeeds.
       */
      if (
        previousSignatureKey &&
        previousSignatureKey !== uploadedSignatureKey
      ) {
        await deleteObjectFromS3(
          previousSignatureKey,
        ).catch((cleanupError) =>
          console.error(
            "Error deleting replaced agreement signature:",
            cleanupError,
          ),
        )
      }

      const agreement =
        agreementResult.rows[0]

      const signatureUrl =
        await getSignedUrlForKey(
          agreement.signature_s3_key,
          {
            expiresIn: 60 * 15,
            responseContentDisposition:
              `inline; filename="signature.png"`,
          },
        )

      return res.json({
        message: "Entente signée avec succès",

        agreement: {
          ...agreement,
          signature_url: signatureUrl,
        },
      })
    } catch (error) {
      if (!committed) {
        await client
          .query("ROLLBACK")
          .catch(() => undefined)

        if (uploadedSignatureKey) {
          await deleteObjectFromS3(
            uploadedSignatureKey,
          ).catch((cleanupError) =>
            console.error(
              "Error cleaning up agreement signature:",
              cleanupError,
            ),
          )
        }
      }

      console.error(
        "Error signing worker interview agreement:",
        error,
      )

      return res.status(500).json({
        message:
          "Erreur lors de la signature de l'entente",
      })
    } finally {
      client.release()
    }
  },
)

/* =========================================================
   SOFT DELETE DRAFT
========================================================= */

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
          message:
            "Brouillon introuvable",
        })
      }

      return res.json({
        message:
          "Brouillon supprimé",

        interview:
          result.rows[0],
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

/* =========================================================
   RESTORE DRAFT
========================================================= */

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
          message:
            "Brouillon supprimé introuvable",
        })
      }

      return res.json({
        message:
          "Brouillon restauré",

        interview:
          result.rows[0],
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
