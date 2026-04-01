import { Router } from "express";
import { pool } from "../../db";


const router = Router();





router.get("/foreign-worker-info", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    const userId = req.user.id;

    const result = await pool.query(
      `
      SELECT
        user_id,
        birth_date,
        residence_country,
        phone_number,
        job_title,
        job_description,
        hourly_wage,
        overtime_hourly_wage,
        daily_hours_for_overtime,
        weekly_hours_for_overtime,
        contingent_applicable,
        contingent_details,
        debut_date,
        job_duration,
        approximative_daily_hours,
        approximative_weekly_hours,
        is_full_time,
        no_full_time_details,
        holidays,
        no_holidays_compensation,
        invalid_insurance,
        dentist_insurance,
        pension_scheme,
        healthcare,
        other,
        other_details,
        accommodation_type,
        on_site_accommodation,
        off_site_accommodation_under_30,
        off_site_accommodation_custom,
        weekly_amount_deducted,
        monthly_amount_deducted,
        low_wage,
        accommodation_provided,
        high_wage,
        more_info_ptet,
        pin
      FROM foreign_workers_info
      WHERE user_id = $1
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Aucune information de travailleur étranger trouvée pour cet utilisateur",
      });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching foreign worker info:", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la récupération des informations",
    });
  }
});

router.post("/foreign-worker-info/by-pin", async (req, res) => {
  try {
    const { pin } = req.body;

    if (pin === undefined || pin === null || pin === "") {
      return res.status(400).json({ error: "Le PIN est requis" });
    }

    const normalizedPin = Number(pin);

    if (!Number.isInteger(normalizedPin) || normalizedPin < 0 || normalizedPin > 99999) {
      return res.status(400).json({ error: "PIN invalide" });
    }

    const result = await pool.query(
      `
      SELECT
        fwi.user_id,
        u.id,
        u.username,
        u.name,
        u.surname,
        u.email,
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
        fwi.pin
      FROM foreign_workers_info fwi
      INNER JOIN users u
        ON u.id = fwi.user_id
      WHERE fwi.pin = $1
      LIMIT 1
      `,
      [normalizedPin]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Aucun travailleur trouvé avec ce PIN",
      });
    }

    return res.status(200).json({
      message: "Travailleur trouvé",
      worker: result.rows[0],
    });
  } catch (err) {
    console.error("Error fetching foreign worker info by PIN:", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la récupération des informations",
    });
  }
});


export default router;