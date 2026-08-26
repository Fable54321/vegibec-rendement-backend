import express from "express";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";
import { getContractAccessDetails } from "../../Utils/ContractHelpers/buildContracSession";
import multer from "multer";
import path from "path";
import { uploadBufferToS3, getSignedUrlForKey } from "../../services/s3.services";


const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
  },
});

const allowedImageMimeTypes = ["image/jpeg", "image/png", "image/webp"];


router.get("/foreign-workers", requireAppRole("main", ["admin", "user", "guest"]), async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        u.id,
        u.name,
        u.surname,
        u.username,
        fwi.matricula,
        fwi.pin,
        fwi.contract_type,
        fwi.residence_country,
        fwi.debut_date,
        fwd.job_id_1,
        fwd.job_id_2
      FROM users u
      INNER JOIN foreign_workers_info fwi
        ON fwi.user_id = u.id
      LEFT JOIN foreign_workers_schedule.foreign_workers_details fwd
        ON fwd.user_id = u.id
      ORDER BY u.surname ASC, u.name ASC
      `
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching foreign workers:", err);
    return res.status(500).json({ error: "Erreur lors de la récupération des travailleurs" });
  }
});


router.get("/foreign-workers/contracts/:id", requireAppRole("main", ["admin"]), async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "ID invalide" });
    }

    const result = await pool.query(
      `
      SELECT
        current_contracts.id,
        current_contracts.user_id,
        current_contracts.status,
        current_contracts.created_at,
        current_contracts.updated_at,
        current_contracts.signed_at,
        current_contracts.draft_pdf_key,
        current_contracts.final_pdf_key,
        current_contracts.contract_slug
      FROM (
        SELECT DISTINCT ON (wc.contract_slug)
          wc.id,
          wc.user_id,
          wc.status,
          wc.created_at,
          wc.updated_at,
          wc.signed_at,
          wc.draft_pdf_key,
          wc.final_pdf_key,
          wc.contract_slug
        FROM worker_contracts wc
        WHERE wc.user_id = $1
        ORDER BY
          wc.contract_slug,
          CASE WHEN wc.status = 'signed' THEN 0 ELSE 1 END,
          wc.updated_at DESC,
          wc.id DESC
      ) current_contracts
      ORDER BY current_contracts.created_at DESC
      `,
      [userId]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching worker contracts:", err);
    return res.status(500).json({ error: "Erreur lors de la récupération des contrats" });
  }
});

// Post picture to s3 storage in order ot get a signed url

router.patch(
  "/foreign-workers/:id/personal-picture",
  requireAppRole("main", ["admin"]),
  upload.single("picture"),
  async (req, res) => {
    try {
      const userId = Number(req.params.id);

      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: "ID invalide" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "Aucune image envoyée" });
      }

      if (!allowedImageMimeTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          error: "Seules les images JPEG, PNG et WEBP sont acceptées",
        });
      }

      const existingWorker = await pool.query(
        `
        SELECT u.id
        FROM users u
        INNER JOIN foreign_workers_info fwi
          ON fwi.user_id = u.id
        WHERE u.id = $1
        `,
        [userId]
      );

      if (existingWorker.rows.length === 0) {
        return res.status(404).json({ error: "Travailleur introuvable" });
      }

      const extensionFromMime: Record<string, string> = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/svg+xml": ".svg",
      };

      const extension =
        extensionFromMime[req.file.mimetype] ||
        path.extname(req.file.originalname).toLowerCase() ||
        ".jpg";

      const personalPictureKey = `foreign-workers/personal-pictures/user-${userId}-${Date.now()}${extension}`;

      await uploadBufferToS3({
        key: personalPictureKey,
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
      });

      const updateResult = await pool.query(
        `
        UPDATE foreign_workers_schedule.foreign_workers_details
        SET personal_picture_key = $1
        WHERE user_id = $2
        RETURNING
          id,
          user_id,
          personal_picture_key
        `,
        [personalPictureKey, userId]
      );

      if (updateResult.rows.length === 0) {
        return res.status(404).json({
          error: "Détails du travailleur introuvables",
        });
      }

      const personalPictureUrl = await getSignedUrlForKey(personalPictureKey);

      return res.status(200).json({
        message: "Photo mise à jour avec succès",
        detailsId: updateResult.rows[0].id,
        userId: updateResult.rows[0].user_id,
        personalPictureKey: updateResult.rows[0].personal_picture_key,
        personalPictureUrl,
      });
    } catch (err) {
      console.error("Error uploading worker personal picture:", err);
      return res.status(500).json({
        error: "Erreur lors du téléversement de la photo",
      });
    }
  }
);


//Get all info from foreign_workers_info + picture url

router.get("/foreign-workers/:id", requireAppRole("main", ["admin"]), async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "ID invalide" });
    }

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.name,
        u.surname,
        u.username,
        u.email,
        u.role,
        u.uses_worksheet,

        fwi.birth_date,
        fwi.residence_country,
        fwi.phone_number,
        fwi.job_title,
        fwi.job_description,
        fwi.hourly_wage,
        fwi.overtime_hourly_wage,
        fwi.daily_hours_for_overtime,
        fwi.weekly_hours_for_overtime,
        fwi.contingent_applicable,
        fwi.contingent_details,
        fwi.debut_date,
        fwi.job_duration,
        fwi.approximative_daily_hours,
        fwi.approximative_weekly_hours,
        fwi.is_full_time,
        fwi.no_full_time_details,
        fwi.holidays,
        fwi.no_holidays_compensation,
        fwi.invalid_insurance,
        fwi.dentist_insurance,
        fwi.pension_scheme,
        fwi.healthcare,
        fwi.other,
        fwi.other_details,
        fwi.accommodation_type,
        fwi.on_site_accommodation,
        fwi.off_site_accommodation_under_30,
        fwi.off_site_accommodation_custom,
        fwi.weekly_amount_deducted,
        fwi.monthly_amount_deducted,
        fwi.low_wage,
        fwi.accommodation_provided,
        fwi.high_wage,
        fwi.more_info_ptet,
        fwi.pin,
        fwi.is_connected,
        fwi.holiday_duration,
        fwi.matricula,
        fwi.contract_type,
        fwi.nas,
        fwi.ramq,
        fwi.folio_number,

        fwd.id AS foreign_workers_details_id,
fwd.has_license,
fwd.personal_picture_key,
fwd.day_off,
fwd.job_id_1,
fwd.job_id_2,
fwd.job_notes,
fwd.casa_id,
casa.name AS casa_name,
fwd.cuartos_id,
cuarto.name AS cuarto_name

      FROM users u
      INNER JOIN foreign_workers_info fwi
        ON fwi.user_id = u.id
        LEFT JOIN foreign_workers_schedule.foreign_workers_details fwd
  ON fwd.user_id = u.id
        LEFT JOIN foreign_workers_schedule.cuartos cuarto
  ON cuarto.id = fwd.cuartos_id
        LEFT JOIN foreign_workers_schedule.casas casa
  ON casa.id = fwd.casa_id
      WHERE u.id = $1
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Travailleur introuvable" });
    }

    const worker = result.rows[0];

const personalPictureUrl = worker.personal_picture_key
  ? await getSignedUrlForKey(worker.personal_picture_key)
  : null;

return res.status(200).json({
  ...worker,
  personal_picture_url: personalPictureUrl,
});

  } catch (err) {
    console.error("Error fetching foreign worker:", err);
    return res.status(500).json({ error: "Erreur lors de la récupération du travailleur" });
  }
});

router.get(
  "/foreign-workers/:userId/contracts/:contractId",
  requireAppRole("main", ["admin"]),
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      const contractId = Number(req.params.contractId);

      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: "userId invalide" });
      }

      if (!Number.isInteger(contractId) || contractId <= 0) {
        return res.status(400).json({ error: "contractId invalide" });
      }

      const contract = await getContractAccessDetails(contractId);

      if (contract.userId !== userId) {
        return res.status(404).json({ error: "Contrat introuvable pour ce travailleur" });
      }

      const pdfKey = contract.finalPdfKey || contract.draftPdfKey;

      return res.status(200).json({
        id: contract.contractId,
        user_id: contract.userId,
        status: contract.status,
        contract_slug: contract.slug,
        created_at: contract.createdAt,
        updated_at: contract.updatedAt,
        signed_at: contract.signedAt,
        draft_pdf_key: contract.draftPdfKey,
        final_pdf_key: contract.finalPdfKey,
        pdf_key: pdfKey,
        url: contract.accessUrl,
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message === "Contrat introuvable" ||
          err.message === "Aucun PDF trouve pour ce contrat")
      ) {
        return res.status(404).json({ error: err.message });
      }

      console.error("Error fetching specific worker contract:", err);
      return res.status(500).json({ error: "Erreur lors de la récupération du contrat" });
    }
  }
);


router.patch("/foreign-workers/:id", requireAppRole("main", ["admin"]), async (req, res) => {
  const client = await pool.connect();

  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "ID invalide" });
    }

    const allowedUserFields = [
      "name",
      "surname",
      "username",
      "email",
      "role",
      "uses_worksheet",
    ] as const;

    const allowedFwiFields = [
      "birth_date",
      "residence_country",
      "phone_number",
      "job_title",
      "job_description",
      "hourly_wage",
      "overtime_hourly_wage",
      "daily_hours_for_overtime",
      "weekly_hours_for_overtime",
      "contingent_applicable",
      "contingent_details",
      "debut_date",
      "job_duration",
      "approximative_daily_hours",
      "approximative_weekly_hours",
      "is_full_time",
      "no_full_time_details",
      "holidays",
      "no_holidays_compensation",
      "invalid_insurance",
      "dentist_insurance",
      "pension_scheme",
      "healthcare",
      "other",
      "other_details",
      "accommodation_type",
      "on_site_accommodation",
      "off_site_accommodation_under_30",
      "off_site_accommodation_custom",
      "weekly_amount_deducted",
      "monthly_amount_deducted",
      "low_wage",
      "accommodation_provided",
      "high_wage",
      "more_info_ptet",
      "pin",
      "is_connected",
      "holiday_duration",
      "matricula",
      "contract_type",
      "nas",
      "ramq",
      "folio_number",
    ] as const;

    const userUpdates: Record<string, unknown> = {};
    const fwiUpdates: Record<string, unknown> = {};

    for (const field of allowedUserFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        userUpdates[field] = req.body[field];
      }
    }

    for (const field of allowedFwiFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        fwiUpdates[field] = req.body[field];
      }
    }

    if (Object.keys(userUpdates).length === 0 && Object.keys(fwiUpdates).length === 0) {
      return res.status(400).json({ error: "Aucune donnée à modifier" });
    }

    await client.query("BEGIN");

    const existingWorker = await client.query(
      `
      SELECT u.id
      FROM users u
      INNER JOIN foreign_workers_info fwi
        ON fwi.user_id = u.id
      WHERE u.id = $1
      `,
      [userId]
    );

    if (existingWorker.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Travailleur introuvable" });
    }

    if (Object.keys(userUpdates).length > 0) {
      const userSetClauses: string[] = [];
      const userValues: unknown[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(userUpdates)) {
        userSetClauses.push(`${key} = $${paramIndex}`);
        userValues.push(value);
        paramIndex++;
      }

      userSetClauses.push(`updated_at = NOW()`);

      userValues.push(userId);

      await client.query(
        `
        UPDATE users
        SET ${userSetClauses.join(", ")}
        WHERE id = $${paramIndex}
        `,
        userValues
      );
    }

    if (Object.keys(fwiUpdates).length > 0) {
      const fwiSetClauses: string[] = [];
      const fwiValues: unknown[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(fwiUpdates)) {
        fwiSetClauses.push(`${key} = $${paramIndex}`);
        fwiValues.push(value);
        paramIndex++;
      }

      fwiValues.push(userId);

      await client.query(
        `
        UPDATE foreign_workers_info
        SET ${fwiSetClauses.join(", ")}
        WHERE user_id = $${paramIndex}
        `,
        fwiValues
      );
    }

    const updatedWorker = await client.query(
      `
      SELECT
        u.id,
        u.name,
        u.surname,
        u.username,
        u.email,
        u.role,
        u.uses_worksheet,

        fwi.birth_date,
        fwi.residence_country,
        fwi.phone_number,
        fwi.job_title,
        fwi.job_description,
        fwi.hourly_wage,
        fwi.overtime_hourly_wage,
        fwi.daily_hours_for_overtime,
        fwi.weekly_hours_for_overtime,
        fwi.contingent_applicable,
        fwi.contingent_details,
        fwi.debut_date,
        fwi.job_duration,
        fwi.approximative_daily_hours,
        fwi.approximative_weekly_hours,
        fwi.is_full_time,
        fwi.no_full_time_details,
        fwi.holidays,
        fwi.no_holidays_compensation,
        fwi.invalid_insurance,
        fwi.dentist_insurance,
        fwi.pension_scheme,
        fwi.healthcare,
        fwi.other,
        fwi.other_details,
        fwi.accommodation_type,
        fwi.on_site_accommodation,
        fwi.off_site_accommodation_under_30,
        fwi.off_site_accommodation_custom,
        fwi.weekly_amount_deducted,
        fwi.monthly_amount_deducted,
        fwi.low_wage,
        fwi.accommodation_provided,
        fwi.high_wage,
        fwi.more_info_ptet,
        fwi.pin,
        fwi.is_connected,
        fwi.holiday_duration,
        fwi.matricula,
        fwi.contract_type,
        fwi.nas,
        fwi.ramq,
        fwi.folio_number
      FROM users u
      INNER JOIN foreign_workers_info fwi
        ON fwi.user_id = u.id
      WHERE u.id = $1
      `,
      [userId]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      message: "Travailleur mis à jour avec succès",
      worker: updatedWorker.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating foreign worker:", err);
    return res.status(500).json({ error: "Erreur lors de la mise à jour du travailleur" });
  } finally {
    client.release();
  }
});



export default router;
