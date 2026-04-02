import { Router } from "express";
import { pool } from "../../db";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs/promises";
import path from "path";
import { employer, getJobDescription } from "../../Utils/DocumentInfo";


const router = Router();

const drawField = (
  page: any,
  text: string,
  x: number,
  y: number,
  font: any,
  lineHeight: number,
  size = 11
) => {
  page.drawText(text || "", {
    x,
    y,
    size,
    font,
    color: rgb(0, 0, 0),
    lineHeight: lineHeight,
  });
};



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

    if (
      !Number.isInteger(normalizedPin) ||
      normalizedPin < 0 ||
      normalizedPin > 99999
    ) {
      return res.status(400).json({ error: "PIN invalide" });
    }

    const result = await pool.query(
      `
      SELECT COUNT(*) as count
      FROM foreign_workers_info
      WHERE pin = $1
      `,
      [normalizedPin]
    );

    if (parseInt(result.rows[0].count) === 0) {
      return res.status(404).json({
        error: "Aucun travailleur trouvé avec ce PIN",
      });
    }

    // ✅ MARK AS CONNECTED
    await pool.query(
      `
      UPDATE foreign_workers_info
      SET is_connected = true
      WHERE pin = $1
      `,
      [normalizedPin]
    );

    return res.status(200).json({
      message: "Travailleur connecté avec succès",
    });
  } catch (err) {
    console.error("Error connecting foreign worker by PIN:", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la connexion du travailleur",
    });
  }
});

router.post("/foreign-worker-info/disconnect", async (req, res) => {
  try {
    const { pin } = req.body;

    if (!pin) {
      return res.status(400).json({ error: "Le PIN est requis" });
    }

    const normalizedPin = Number(pin);

    await pool.query(
      `
      UPDATE foreign_workers_info
      SET is_connected = false
      WHERE pin = $1
      `,
      [normalizedPin]
    );

    return res.status(200).json({
      message: "Travailleur déconnecté",
    });
  } catch (err) {
    console.error("Error disconnecting worker:", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la déconnexion",
    });
  }
});

router.get("/foreign-worker-info/current", async (req, res) => {
  try {
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
        fwi.is_connected,
        fwi.pin
      FROM foreign_workers_info fwi
      INNER JOIN users u
        ON u.id = fwi.user_id
      WHERE fwi.is_connected = true
      LIMIT 1
      `
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Aucun travailleur connecté trouvé" });
    }

    return res.status(200).json({ worker: result.rows[0] });
  } catch (err) {
    console.error("Error fetching current connected worker:", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la récupération du travailleur connecté",
    });
  }
});

router.post("/foreign-worker-contract/by-pin", async (req, res) => {
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
      return res.status(404).json({ error: "Aucun travailleur trouvé avec ce PIN" });
    }

    const worker = result.rows[0];

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
    




    firstPage.drawText(`${worker.surname}`, {
      x: 222,
      y: 391,
      size: 12,
      font: boldFont,
      color: rgb(0, 0, 0),
    });

        firstPage.drawText(`${worker.name}`, {
      x: 254,
      y: 368,
      size: 12,
      font: boldFont,
      color: rgb(0, 0, 0),
    });

    firstPage.drawText(worker.birth_date ? new Date(worker.birth_date).toLocaleDateString("fr-CA") : "", {
      x: 194,
      y: 346,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    });

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
    })

    /////EMPLOYER

     firstPage.drawText(employer.surname ?? "", {
      x: 145,
      y: 238,
      size: 11,
      font : boldFont,
      color: rgb(0, 0, 0),
    })

      firstPage.drawText(employer.name ?? "", {
      x: 176.5,
      y: 193,
      size: 11,
      font: boldFont,
      color: rgb(0, 0, 0),
    })

      firstPage.drawText(employer.phone_number ?? "", {
      x: 205,
      y: 170.5,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    })

      firstPage.drawText(employer.company ?? "", {
      x: 253,
      y: 140,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    })

      firstPage.drawText(employer.address ?? "", {
      x: 133,
      y: 118,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    })

      firstPage.drawText(employer.email ?? "", {
      x: 206,
      y: 73,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    })

    firstPage.drawText(employer.website, {
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

    const jobDescription = getJobDescription(worker.job_title ?? "") || worker.job_description || "";

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
      }
    );

    secondPage.drawText(
      worker.debut_date ? new Date(worker.debut_date).toLocaleDateString("fr-CA") : "",
      {
        x: 272,
        y: 225,
        size: 11,
        font,
        color: rgb(0, 0, 0),
      }
    );

    const pdfBytes = await pdfDoc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="contrat-${worker.surname}-${worker.name}.pdf"`
    );

    return res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("Error generating foreign worker contract PDF:", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la génération du PDF",
    });
  }
});


export default router;