import express from "express";
import { generateImpAutContract } from "../GenerateImpAut";
const router = express.Router();




router.get("/debug/contract-preview/impaut", async (_req, res) => {
  try {
    const worker = {
      user_id: 1,
      name: "JUAN",
      surname: "PEREZ",
      matricula: "987",
      debut_date: "2026-04-29",
      username: null,
      email: null,
      birth_date: null,
      residence_country: null,
      phone_number: null,
      job_title: null,
      job_description: null,
      hourly_wage: null,
      overtime_hourly_wage: null,
      daily_hours_for_overtime: null,
      weekly_hours_for_overtime: null,
      contingent_applicable: null,
      contingent_details: null,
      job_duration: null,
      approximative_daily_hours: null,
      approximative_weekly_hours: null,
      is_full_time: null,
      no_full_time_details: null,
      holidays: null,
      no_holidays_compensation: null,
      invalid_insurance: null,
      dentist_insurance: null,
      pension_scheme: null,
      healthcare: null,
      other: null,
      other_details: null,
      accommodation_type: null,
      on_site_accommodation: null,
      off_site_accommodation_under_30: null,
      off_site_accommodation_custom: null,
      weekly_amount_deducted: null,
      monthly_amount_deducted: null,
      low_wage: null,
      accommodation_provided: null,
      high_wage: null,
      more_info_ptet: null,
      pin: null,
      holiday_duration: null,
      nas: null,
    };

    const employer = {
      surname: "BISSONNETTE",
      name: "TIMOTHE",
      phone_number: "5140000000",
      company: "Vegibec inc.",
      address: "123 Test Street",
      email: "test@vegibec.com",
      website: "vegibec.com",
    };

    const pdfBuffer = await generateImpAutContract({
      worker,
      employer,
      getJobDescription: (jobTitle: string) => jobTitle,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="ImpAut-preview.pdf"');
    res.send(pdfBuffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Preview generation failed" });
  }
});


export default router;