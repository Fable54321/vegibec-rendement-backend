import express from "express";
import { pool } from "../../db";

const router = express.Router();

/**
 * 1) Get all foreign workers
 * Used to display the list of names
 */
router.get("/foreign-workers", async (_req, res) => {
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
        fwi.residence_country
      FROM users u
      INNER JOIN foreign_workers_info fwi
        ON fwi.user_id = u.id
      ORDER BY u.surname ASC, u.name ASC
      `
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching foreign workers:", err);
    return res.status(500).json({ error: "Erreur lors de la récupération des travailleurs" });
  }
});


router.get("/foreign-workers/contracts/:id", async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "ID invalide" });
    }

    const result = await pool.query(
      `
      SELECT
        wc.id,
        wc.user_id,
        wc.contract_type,
        wc.status,
        wc.created_at,
        wc.updated_at,
        wc.signed_at,
        wc.pdf_url,
        wc.contract_slug
      FROM worker_contracts wc
      WHERE wc.user_id = $1
      ORDER BY wc.created_at DESC
      `,
      [userId]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching worker contracts:", err);
    return res.status(500).json({ error: "Erreur lors de la récupération des contrats" });
  }
});

router.get("/foreign-workers/:id", async (req, res) => {
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
        fwi.folio_number
      FROM users u
      INNER JOIN foreign_workers_info fwi
        ON fwi.user_id = u.id
      WHERE u.id = $1
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Travailleur introuvable" });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching foreign worker:", err);
    return res.status(500).json({ error: "Erreur lors de la récupération du travailleur" });
  }
});

/**
 * 3) Get contracts for one worker
 * Used for the contracts page/tab of a specific worker
 */


export default router;