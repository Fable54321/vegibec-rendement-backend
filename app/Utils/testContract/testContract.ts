import express from "express";
import fs from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { drawCoordinateGrid, drawField } from "../drawField";
import { generateImpCons } from "../GenerateImpCons";
const router = express.Router();

type FieldPlacement = {
  label: string;
  value: string;
  x: number;
  y: number;
  width?: number;
};

function readNumber(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  const raw = Array.isArray(value) ? value[0] : value;

  if (raw === undefined) {
    return fallback;
  }

  return raw === "true" || raw === "1" || raw === "yes";
}

function getFieldPlacements(query: express.Request["query"]): FieldPlacement[] {
  return [
    {
      label: "matricula",
      value: String(query.matriculaText ?? "987"),
      x: 255,
      y: 593,
      width: 75,
    },
    {
      label: "workerName",
      value: String(query.workerNameText ?? "PEREZ JUAN"),
      x: 215,
      y: 549,
      width: 180,
    },
    {
      label: "signatureDate",
      value: String(query.signatureDateText ?? "2026-04-29"),
      x: 138,
      y: 75,
      width: 110,
    },
    {
      label: "signature",
      value: String(query.employerNameText ?? "SIGNATURE TEST"),
      x: 268,
      y: 142,
      width: 150,
    },
  ];
}


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
      nas: "111111111",
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

    const pdfBuffer = await generateImpCons({
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

router.get("/debug/contract-preview/autlav", async (req, res) => {
  try {
    const templatePath = path.join(
      process.cwd(),
      "public",
      "templates",
      "Aut-lav.pdf",
    );

    const existingPdfBytes = await fs.readFile(templatePath);
    const pdfDoc = await PDFDocument.load(existingPdfBytes, {
      ignoreEncryption: true,
    });
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const [firstPage] = pdfDoc.getPages();

    if (readBoolean(req.query.grid, true)) {
      drawCoordinateGrid(firstPage);
    }

    for (const placement of getFieldPlacements(req.query)) {
      drawField(firstPage, {
        ...placement,
        height: 16,
        font,
        size: readNumber(req.query.size, 11),
        debug: readBoolean(req.query.debug, false),
      });
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="AutLav-preview.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Aut-lav preview generation failed" });
  }
});


export default router;
