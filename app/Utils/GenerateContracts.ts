import fs from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

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
};

type ContractSlug = "PTAS" | "PTET";

type SignaturePlacement = {
  signaturePageIndex: number;
  signatureX: number;
  signatureY: number;
  signatureWidth: number;
  signatureHeight: number;
  dateX: number;
  dateY: number;
  nameX?: number;
  nameY?: number;
};

type Employer = {
  surname: string | null;
  name: string | null;
  phone_number: string | null;
  company: string | null;
  address: string | null;
  email: string | null;
  website: string | null;
};

type GeneratePTASContractParams = {
  worker: Worker;
  employer: Employer;
  getJobDescription: (jobTitle: string) => string | undefined;
};


type GeneratePTETContractParams = {
  worker: Worker;
  employer: Employer;
  getJobDescription: (jobTitle: string) => string | undefined;
};

export const generatePTETContract = async ({
  worker,
  employer,
  getJobDescription,
}: GeneratePTETContractParams): Promise<Buffer> => {
  const templatePath = path.join(
    process.cwd(),
    "public",
    "templates",
    "contrat_PTET_clean_version.pdf",
  );

  const existingPdfBytes = await fs.readFile(templatePath);

  const pdfDoc = await PDFDocument.load(existingPdfBytes, {
    ignoreEncryption: true,
  });

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pages = pdfDoc.getPages();
  const firstPage = pages[0];
  const secondPage = pages[1];
  const thirdPage = pages[2];
  const fourthPage = pages[3];
  const fifthPage = pages[4];

  firstPage.drawText(`${worker.surname ?? ""}`, {
    x: 247,
    y: 397,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(`${worker.name ?? ""}`, {
    x: 246,
    y: 375,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(
    worker.birth_date
      ? new Date(worker.birth_date).toLocaleDateString("fr-CA")
      : "",
    {
      x: 244,
      y: 357,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );

  firstPage.drawText(worker.residence_country ?? "", {
    x: 244,
    y: 341,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(worker.phone_number ?? "", {
    x: 244,
    y: 318,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(worker.email ?? "", {
    x: 244,
    y: 293,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  // EMPLOYER
  firstPage.drawText(employer.surname ?? "", {
    x: 244,
    y: 250,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.name ?? "", {
    x: 244,
    y: 214,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.phone_number ?? "", {
    x: 244,
    y: 195,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.company ?? "", {
    x: 244,
    y: 174,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.address ?? "", {
    x: 244,
    y: 148,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.email ?? "", {
    x: 244,
    y: 69,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.website ?? "", {
    x: 244,
    y: 47,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText(worker.job_title ?? "", {
    x: 123,
    y: 656,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  const jobDescription =
    getJobDescription(worker.job_title ?? "") || worker.job_description || "";

  secondPage.drawText(jobDescription, {
    x: 43,
    y: 619,
    size: 9,
    font,
    lineHeight: 12,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText(
    worker.hourly_wage !== null && worker.hourly_wage !== undefined
      ? `${worker.hourly_wage} $`
      : "",
    {
      x: 142,
      y: 525.5,
      size: 10,
      font,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText(
    worker.overtime_hourly_wage !== null &&
      worker.overtime_hourly_wage !== undefined
      ? `${worker.overtime_hourly_wage} `
      : "",
    {
      x: 270,
      y: 499,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText(
    worker.daily_hours_for_overtime !== null &&
      worker.daily_hours_for_overtime !== undefined
      ? `${worker.daily_hours_for_overtime}`
      : "",
    {
      x: 390,
      y: 507,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText(
    worker.weekly_hours_for_overtime ? `${worker.weekly_hours_for_overtime}` : "",
    {
      x: 390,
      y: 489,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );

  // no contingent
  secondPage.drawText("X", {
    x: 490.5,
    y: 468.5,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

    secondPage.drawText(
    worker.debut_date
      ? new Date(worker.debut_date).toLocaleDateString("fr-CA")
      : "",
    {
      x: 388.5,
      y: 233,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText("8", {
    x: 286.5,
    y: 214.5,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText("X", {
    x: 452.5,
    y: 215,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText(
    worker.approximative_daily_hours
      ? `${worker.approximative_daily_hours} h`
      : "",
    {
      x: 450.5,
      y: 199,
      size: 11,
      font: boldFont,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText(
    worker.approximative_weekly_hours
      ? `${worker.approximative_weekly_hours} h`
      : "",
    {
      x: 470,
      y: 184,
      size: 11,
      font: boldFont,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText("X", {
    x: 315,
    y: 165,
    size: 13,
    font: boldFont,
    color: rgb(0, 0, 0),
  });



  secondPage.drawText("X", {
    x: 41,
    y: 53,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText(
    worker.holiday_duration ? `${worker.holiday_duration}%` : "",
    {
      x: 263,
      y: 53,
      size: 11,
      font: boldFont,
      color: rgb(0, 0, 0),
    },
  );

//VOLET AGRICOLE


  thirdPage.drawText("X", {
    x: 235,
    y: 453,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  })

    thirdPage.drawText("X", {
    x: 41,
    y: 150,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  })

  fourthPage.drawText("Maison mobile", {
    x: 100,
    y: 600,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  fifthPage.drawText("171, rang ste-Sophie, Oka, QC J0N 1E0", {
    x: 48,
    y: 332,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });


    fifthPage.drawText("171, rang ste-Sophie, Oka, QC J0N 1E0", {
    x: 320,
    y: 332,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  fifthPage.drawText("Les jardins vegibec inc.", {
    x: 48,
    y: 296,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

   fifthPage.drawText(`${worker.surname ?? ""}`, {
    x: 316,
    y: 294,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  fifthPage.drawText(`${worker.name ?? ""}`, {
    x: 357,
    y: 294,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
};


export const generatePTASContract = async ({
  worker,
  employer,
  getJobDescription,
}: GeneratePTASContractParams): Promise<Buffer> => {
  const templatePath = path.join(
    process.cwd(),
    "public",
    "templates",
    "contrat-PTAS-clean-version.pdf",
  );

  const existingPdfBytes = await fs.readFile(templatePath);

  const pdfDoc = await PDFDocument.load(existingPdfBytes, {
    ignoreEncryption: true,
  });

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pages = pdfDoc.getPages();
  const firstPage = pages[0];
  const secondPage = pages[1];
  const thirdPage = pages[2];
  const fourthPage = pages[3];

  firstPage.drawText(`${worker.surname ?? ""}`, {
    x: 222,
    y: 391,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(`${worker.name ?? ""}`, {
    x: 254,
    y: 368,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(
    worker.birth_date
      ? new Date(worker.birth_date).toLocaleDateString("fr-CA")
      : "",
    {
      x: 194,
      y: 346,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );

  firstPage.drawText(worker.residence_country ?? "", {
    x: 126,
    y: 324,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(worker.phone_number ?? "", {
    x: 354,
    y: 302,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(worker.email ?? "", {
    x: 310,
    y: 280,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  // EMPLOYER
  firstPage.drawText(employer.surname ?? "", {
    x: 145,
    y: 238,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.name ?? "", {
    x: 176.5,
    y: 193,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.phone_number ?? "", {
    x: 205,
    y: 170.5,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.company ?? "", {
    x: 253,
    y: 140,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.address ?? "", {
    x: 133,
    y: 118,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.email ?? "", {
    x: 206,
    y: 73,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  firstPage.drawText(employer.website ?? "", {
    x: 154.5,
    y: 49,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText(worker.job_title ?? "", {
    x: 107,
    y: 707,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  const jobDescription =
    getJobDescription(worker.job_title ?? "") || worker.job_description || "";

  secondPage.drawText(jobDescription, {
    x: 29,
    y: 670,
    size: 11,
    font,
    lineHeight: 14,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText(
    worker.hourly_wage !== null && worker.hourly_wage !== undefined
      ? `${worker.hourly_wage} $`
      : "",
    {
      x: 472,
      y: 527,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText(
    worker.overtime_hourly_wage !== null &&
      worker.overtime_hourly_wage !== undefined
      ? `${worker.overtime_hourly_wage} $`
      : "",
    {
      x: 300,
      y: 503,
      size: 13,
      font,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText(
    worker.daily_hours_for_overtime !== null &&
      worker.daily_hours_for_overtime !== undefined
      ? `${worker.daily_hours_for_overtime}`
      : "",
    {
      x: 460,
      y: 507,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText(
    worker.weekly_hours_for_overtime ? `${worker.weekly_hours_for_overtime}` : "",
    {
      x: 460,
      y: 489,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );

  // no contingent
  secondPage.drawText("X", {
    x: 350.5,
    y: 454.5,
    size: 15,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText("8", {
    x: 180,
    y: 203.5,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText("X", {
    x: 418.5,
    y: 203.5,
    size: 15,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText(
    worker.approximative_daily_hours
      ? `${worker.approximative_daily_hours} h`
      : "",
    {
      x: 338.5,
      y: 180.5,
      size: 11,
      font: boldFont,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText(
    worker.approximative_weekly_hours
      ? `${worker.approximative_weekly_hours} h`
      : "",
    {
      x: 363,
      y: 156,
      size: 11,
      font: boldFont,
      color: rgb(0, 0, 0),
    },
  );

  secondPage.drawText("X", {
    x: 413,
    y: 131,
    size: 15,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  secondPage.drawText(
    worker.debut_date
      ? new Date(worker.debut_date).toLocaleDateString("fr-CA")
      : "",
    {
      x: 272,
      y: 225,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    },
  );

  thirdPage.drawText("X", {
    x: 54,
    y: 698,
    size: 15,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  thirdPage.drawText(
    worker.holiday_duration ? `${worker.holiday_duration}%` : "",
    {
      x: 196,
      y: 698,
      size: 11,
      font: boldFont,
      color: rgb(0, 0, 0),
    },
  );

  thirdPage.drawText("Maison mobile", {
    x: 50,
    y: 161,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  fourthPage.drawText("171, rang ste-Sophie, Oka, QC J0N 1E0", {
    x: 37,
    y: 300,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

  fourthPage.drawText("Les jardins vegibec inc.", {
    x: 31,
    y: 262,
    size: 11,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  fourthPage.drawText("171, rang ste-Sophie, Oka, QC J0N 1E0", {
    x: 319,
    y: 300,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });

   fourthPage.drawText(`${worker.surname ?? ""} ${worker.name ?? ""}`, {
    x: 319,
    y: 262,
    size: 12,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
};


export const getSignaturePlacement = (
  contractSlug: ContractSlug
): SignaturePlacement => {
  if (contractSlug === "PTAS") {
    return {
      signaturePageIndex: 3, 
      signatureX: 329,
      signatureY: 190,
      signatureWidth: 220,
      signatureHeight: 50,
      dateX: 470,
      dateY: 162,
    };
  }

  if (contractSlug === "PTET") {
    return {
      signaturePageIndex: 4, // fifth page
      signatureX: 322,
      signatureY: 200,
      signatureWidth: 220,
      signatureHeight: 50,
      dateX: 420,
      dateY: 210,
    };
  }

  throw new Error("Type de contrat invalide");
};


type ApplySignatureParams = {
  pdfBuffer: Buffer;
  contractSlug: ContractSlug;
  signatureBuffer: Buffer;
  signedAt?: Date;
  signedName?: string;
};

export const applySignatureToContract = async ({
  pdfBuffer,
  contractSlug,
  signatureBuffer,
  signedAt,
  signedName,
}: ApplySignatureParams): Promise<Buffer> => {
  const pdfDoc = await PDFDocument.load(pdfBuffer, {
    ignoreEncryption: true,
  });

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const signatureImage = await pdfDoc.embedPng(signatureBuffer);

  const placement = getSignaturePlacement(contractSlug);
  const page = pdfDoc.getPages()[placement.signaturePageIndex];

  page.drawImage(signatureImage, {
    x: placement.signatureX,
    y: placement.signatureY,
    width: placement.signatureWidth,
    height: placement.signatureHeight,
  });

  const formattedDate = (signedAt ?? new Date()).toLocaleDateString("fr-CA");

  page.drawText(formattedDate, {
    x: placement.dateX,
    y: placement.dateY,
    size: 10,
    font,
    color: rgb(0, 0, 0),
  });

  if (signedName && placement.nameX !== undefined && placement.nameY !== undefined) {
    page.drawText(signedName, {
      x: placement.nameX,
      y: placement.nameY,
      size: 10,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
  }

  const finalPdfBytes = await pdfDoc.save();
  return Buffer.from(finalPdfBytes);
};
