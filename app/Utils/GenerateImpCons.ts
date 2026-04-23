
import path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fs from "fs/promises";
import { drawCoordinateGrid } from "./drawField";


type Employer = {
  surname: string | null;
  name: string | null;
  phone_number: string | null;
  company: string | null;
  address: string | null;
  email: string | null;
  website: string | null;
};


type Worker = {
  user_id: number;
  name: string | null;
  surname: string | null;
  username: string | null;
  email: string | null;
  birth_date: string | null;
  residence_country: string | null;
  phone_number: string | null;
  job_title: string | null;
  job_description: string | null;
  hourly_wage: number | null;
  overtime_hourly_wage: number | null;
  daily_hours_for_overtime: number | null;
  weekly_hours_for_overtime: number | null;
  contingent_applicable: boolean | null;
  contingent_details: string | null;
  debut_date: string | null;
  job_duration: string | null;
  approximative_daily_hours: number | null;
  approximative_weekly_hours: number | null;
  is_full_time: boolean | null;
  no_full_time_details: string | null;
  holidays: string | null;
  no_holidays_compensation: string | null;
  invalid_insurance: string | null;
  dentist_insurance: string | null;
  pension_scheme: string | null;
  healthcare: string | null;
  other: string | null;
  other_details: string | null;
  accommodation_type: string | null;
  on_site_accommodation: string | null;
  off_site_accommodation_under_30: string | null;
  off_site_accommodation_custom: string | null;
  weekly_amount_deducted: number | null;
  monthly_amount_deducted: number | null;
  low_wage: boolean | null;
  accommodation_provided: boolean | null;
  high_wage: boolean | null;
  more_info_ptet: string | null;
  pin: number | null;
  holiday_duration: number | null;
  matricula: string | null;
  nas: string | null;
};


type GenerateImpConsParams = {
  worker: Worker;
  employer: Employer;
  getJobDescription: (jobTitle: string) => string | undefined;
};



export const generateImpCons = async ({
  worker,
  employer,
  getJobDescription,
} : GenerateImpConsParams): Promise<Buffer> => {




  const templatePath = path.join(
    process.cwd(),
    "public",
    "templates",
    "ImpotConsentement.pdf",
  );

   const existingPdfBytes = await fs.readFile(templatePath);

  const pdfDoc = await PDFDocument.load(existingPdfBytes, {
    ignoreEncryption: true,
  });

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pages = pdfDoc.getPages();
  const firstPage = pages[0];

 




  firstPage.drawText(`${worker.surname ?? ""} ${worker.name ?? ""}`, {
    x: 50,
    y: 149,
    size: 11,
    font: boldFont,
  });


  firstPage.drawText(`${worker.nas}`, {
    x: 50,
    y: 111,
    size: 11,
    font: boldFont,
  });

firstPage.drawText("SIGNATURE TEST", {
    x: 350,
    y: 149,
    size: 20,
    font: boldFont,
  });

  firstPage.drawText("2026-08-06", {
    x: 330,
    y: 110,
    size: 11,
    font: boldFont,
  });


drawCoordinateGrid(firstPage);



  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);

}