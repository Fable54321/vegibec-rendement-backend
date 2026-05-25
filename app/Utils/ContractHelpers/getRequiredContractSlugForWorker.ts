
import { pool } from "../../db";


export function getRequiredContractSlugsForWorker(worker: { contract_type?: string | null }) {
  const base = [
    "0Au",
    "0Av",
    "0Lo",
    "Aut-ded",
    "Aut-ret",
    "Aut-lav",
    "Imp-aut",
    "Imp-con",
    "Pol-bris",
    "Pol-harc",
    "Pol-prot",
    "Pol-vio",
  ];

  const mainContract = worker.contract_type === "PTAS" ? "PTAS" : "PTET";

  return [mainContract, ...base];
}

export function getContractTitle(contractSlug: string): string {
  const titles: Record<string, string> = {
    PTAS: "Contrat PTAS",
    PTET: "Contrat PTET",
    "0Au": "Annexe 0Au",
    "0Av": "Annexe 0Av",
    "0Lo": "Annexe 0Lo",
    "Aut-ded": "Autorisation de déduction",
    "Aut-ret": "Autorisation de retenue",
    "Aut-lav": "Autorisation de lavage",
    "Imp-aut": "Imp-Autorisation",
    "Imp-con": "Imp-Contrat",
    "Pol-bris": "Politique - bris",
    "Pol-harc": "Politique - harcèlement",
    "Pol-prot": "Politique - protection",
    "Pol-vio": "Politique - violence",
  };

  return titles[contractSlug] ?? contractSlug;
}


export async function getWorkerFullByPin(pin: string | number) {
  const result = await pool.query(
    `
    SELECT
      u.id AS user_id,
      u.name,
      u.surname,
      u.username,
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
      fwi.pin,
      fwi.holiday_duration,
      fwi.matricula,
      fwi.nas,
      fwi.contract_type
    FROM foreign_workers_info fwi
    INNER JOIN users u
      ON u.id = fwi.user_id
    WHERE fwi.pin = $1
    LIMIT 1
    `,
    [pin]
  );

  if (result.rows.length === 0) {
    throw new Error("Aucun travailleur trouvé avec ce PIN");
  }

  return result.rows[0];
}


