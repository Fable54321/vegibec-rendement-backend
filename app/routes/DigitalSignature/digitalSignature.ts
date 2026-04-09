import { Router } from "express";
import { pool } from "../../db";
import { uploadBufferToS3, getSignedUrlForKey, getBufferFromS3 } from "../../services/s3.services"

import { employer, getJobDescription } from "../../Utils/DocumentInfo";
import { generatePTASContract, generatePTETContract, applySignatureToContract, generate0AuContract, generate0AvContract } from "../../Utils/GenerateContracts";
import { generate0LoContract } from "../../Utils/Generate0LoContract";
import { generateAutdedContract } from "../../Utils/GenerateAutDed";
import { generateAutretContract } from "../../Utils/generateAutretContract";
import { generatePolBrisContract } from "../../Utils/GeneratePolBriscontract"
import { generatePolHarcContract } from "../../Utils/GeneratePolHarcContract"
import { generatepolProtContract } from "../../Utils/GeneratePolProtContract"
import { generatepolVioContract } from "../../Utils/GeneratePolVio";


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
        fwi.pin,
        fwi.holiday_duration,
        fwi.matricula
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
    const { pin, contractSlug } = req.body;

    

    if (pin === undefined || pin === null || pin === "") {



      return res.status(400).json({ error: "Le PIN est requis" });
    }

    if (!contractSlug || !["PTAS", "PTET", "0Au", "0Av", "0Lo", "Aut-ded", "Aut-ret", "Pol-bris", "Pol-harc", "Pol-prot", "Pol-vio"].includes(contractSlug)) {

      

      return res.status(400).json({ error: "Slug de contrat invalide" });
    }

    

    const normalizedPin = Number(pin);

    if (
      !Number.isInteger(normalizedPin) ||
      normalizedPin < 0 ||
      normalizedPin > 99999
    ) {
      return res.status(400).json({ error: "PIN invalide" });
    }

    const workerResult = await pool.query(
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
        fwi.matricula
      FROM foreign_workers_info fwi
      INNER JOIN users u
        ON u.id = fwi.user_id
      WHERE fwi.pin = $1
      LIMIT 1
      `,
      [normalizedPin]
    );

    if (workerResult.rows.length === 0) {
      return res.status(404).json({
        error: "Aucun travailleur trouvé avec ce PIN",
      });
    }

    const worker = workerResult.rows[0];

    // 1) Check if a signed contract already exists first
    const existingSignedResult = await pool.query(
      `
      SELECT id, final_pdf_key, draft_pdf_key, status, template_version
      FROM worker_contracts
      WHERE user_id = $1
        AND contract_slug = $2
        AND status = 'signed'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
      `,
      [worker.user_id, contractSlug]
    );

    if (existingSignedResult.rows.length > 0) {
      const existingSigned = existingSignedResult.rows[0];

      return res.status(200).json({
        message: "Contrat signé existant",
        contractId: existingSigned.id,
        pdfKey: existingSigned.final_pdf_key,
        status: existingSigned.status,
        templateVersion: existingSigned.template_version,
        reused: true,
      });
    }

    

    // 2) If no signed contract exists, check for an existing draft
    const existingDraftResult = await pool.query(
      `
      SELECT id, draft_pdf_key, final_pdf_key, status, template_version
      FROM worker_contracts
      WHERE user_id = $1
        AND contract_slug = $2
        AND status = 'draft'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
      `,
      [worker.user_id, contractSlug]
    );

    if (existingDraftResult.rows.length > 0) {
      const existingDraft = existingDraftResult.rows[0];

      return res.status(200).json({
        message: "Contrat brouillon déjà existant",
        contractId: existingDraft.id,
        pdfKey: existingDraft.draft_pdf_key,
        status: existingDraft.status,
        templateVersion: existingDraft.template_version,
        reused: true,
      });
    }

    // 3) Otherwise generate a new draft
    let pdfBuffer: Buffer;
    let templateVersion: string;

    

    if (contractSlug === "PTAS") {
      templateVersion = "2026-ptas-v1";
      pdfBuffer = await generatePTASContract({
        worker,
        employer,
        getJobDescription,
      });

    } else if (contractSlug === "0Au") {
      templateVersion = "2026-0Au-v1";
      pdfBuffer = await generate0AuContract({
        worker,
        employer,
        getJobDescription,
      }); }

    else if (contractSlug === "0Av") {
      templateVersion = "2026-0Av-v1";
      pdfBuffer = await generate0AvContract({
        worker,
        employer,
        getJobDescription,
      });
    }

    else if (contractSlug === "0Lo") {
      templateVersion = "2026-0Lo-v1";
      pdfBuffer = await generate0LoContract({
        worker,
        employer,
        getJobDescription,
      });
    }

    else if (contractSlug === "Aut-ded") {
      

      templateVersion = "2026-autded-v1";
      pdfBuffer = await generateAutdedContract({
        worker,
        employer,
        getJobDescription,
      });
    }

    else if (contractSlug === "Aut-ret"){
      templateVersion = "2026-autret-v1";
      pdfBuffer = await generateAutretContract({
        worker,
        employer,
        getJobDescription,
      });
    }

    else if (contractSlug === "Pol-bris") {
      templateVersion = "2026-pol-bris-v1";
      pdfBuffer = await generatePolBrisContract({
        worker,
        employer,
        getJobDescription,
      });
    }

    else if (contractSlug === "Pol-harc") {
      templateVersion = "2026-pol-harc-v1";
      pdfBuffer = await generatePolHarcContract({
        worker,
        employer,
        getJobDescription,
      });
    }

    else if (contractSlug === "Pol-prot") {
      templateVersion = "2026-pol-prot-v1";
      pdfBuffer = await generatepolProtContract({
        worker,
        employer,
        getJobDescription,
      });
    }

    else if (contractSlug === "Pol-vio") {
      templateVersion = "2026-pol-vio-v1";
      pdfBuffer = await generatepolVioContract({
        worker,
        employer,
        getJobDescription,
      });
    }
    
    else {
      templateVersion = "2026-ptet-v1";
      pdfBuffer = await generatePTETContract({
        worker,
        employer,
        getJobDescription,
      });
    }

    const insertResult = await pool.query(
      `
      INSERT INTO worker_contracts (
        user_id,
        contract_slug,
        template_version,
        status,
        worker_snapshot,
        employer_snapshot,
        accepted_terms
      )
      VALUES ($1, $2, $3, 'draft', $4::jsonb, $5::jsonb, false)
      RETURNING id
      `,
      [
        worker.user_id,
        contractSlug,
        templateVersion,
        JSON.stringify(worker),
        JSON.stringify(employer),
      ]
    );

    const contractId = insertResult.rows[0].id;
    const draftPdfKey = `contracts/${worker.user_id}/${contractId}/draft.pdf`;

    await uploadBufferToS3({
      key: draftPdfKey,
      buffer: pdfBuffer,
      contentType: "application/pdf",
    });

    await pool.query(
      `
      UPDATE worker_contracts
      SET draft_pdf_key = $1,
          updated_at = NOW()
      WHERE id = $2
      `,
      [draftPdfKey, contractId]
    );

    return res.status(200).json({
      message: "Contrat brouillon généré avec succès",
      contractId,
      pdfKey: draftPdfKey,
      status: "draft",
      templateVersion,
      reused: false,
    });
  } catch (err) {
    console.error("Error generating foreign worker contract PDF:", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la génération du contrat",
    });
  }
});

router.get("/foreign-worker-contract/:id/url", async (req, res) => {
  try {
    const contractId = Number(req.params.id);

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: "ID de contrat invalide" });
    }

    const result = await pool.query(
      `
      SELECT
        status,
        draft_pdf_key,
        final_pdf_key
      FROM worker_contracts
      WHERE id = $1
      LIMIT 1
      `,
      [contractId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Contrat introuvable" });
    }

    const contract = result.rows[0];

    const keyToUse =
      contract.status === "signed" && contract.final_pdf_key
        ? contract.final_pdf_key
        : contract.draft_pdf_key;

    if (!keyToUse) {
      return res.status(404).json({ error: "Aucun PDF trouvé pour ce contrat" });
    }

    const url = await getSignedUrlForKey(keyToUse);

    return res.status(200).json({
      url,
      status: contract.status,
    });
  } catch (err) {
    console.error("Error getting contract URL:", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la récupération du contrat",
    });
  }
});


router.post("/foreign-worker-contract/:id/sign", async (req, res) => {
  const client = await pool.connect();

  let signatureImageKey: string | null = null;
  let finalPdfKey: string | null = null;

  try {
    const contractId = Number(req.params.id);
    const { signatureDataUrl, acceptedTerms, signedName } = req.body;

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: "ID de contrat invalide" });
    }

    if (!signatureDataUrl || typeof signatureDataUrl !== "string") {
      return res.status(400).json({ error: "Signature requise" });
    }

    if (!acceptedTerms) {
      return res.status(400).json({
        error: "Vous devez accepter le contrat avant de signer",
      });
    }

    await client.query("BEGIN");

    const contractResult = await client.query(
      `
      SELECT
        id,
        user_id,
        contract_slug,
        status,
        draft_pdf_key,
        final_pdf_key
      FROM worker_contracts
      WHERE id = $1
      LIMIT 1
      `,
      [contractId]
    );

    if (contractResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Contrat introuvable" });
    }

    const contract = contractResult.rows[0];

    if (contract.status === "signed") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ce contrat est déjà signé" });
    }

    if (!contract.draft_pdf_key) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Aucun PDF brouillon associé à ce contrat",
      });
    }

    const base64Data = signatureDataUrl.replace(/^data:image\/png;base64,/, "");
    const signatureBuffer = Buffer.from(base64Data, "base64");

    if (!signatureBuffer.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Signature invalide" });
    }

    const draftPdfBuffer = await getBufferFromS3(contract.draft_pdf_key);

    const signedAt = new Date();

    const finalPdfBuffer = await applySignatureToContract({
      pdfBuffer: draftPdfBuffer,
      contractSlug: contract.contract_slug,
      signatureBuffer,
      signedAt,
      signedName,
    });

    signatureImageKey = `contracts/${contract.user_id}/${contract.id}/signature.png`;
    finalPdfKey = `contracts/${contract.user_id}/${contract.id}/final.pdf`;

    await uploadBufferToS3({
      key: signatureImageKey,
      buffer: signatureBuffer,
      contentType: "image/png",
    });

    await uploadBufferToS3({
      key: finalPdfKey,
      buffer: finalPdfBuffer,
      contentType: "application/pdf",
    });

    await client.query(
      `
      UPDATE worker_contracts
      SET
        accepted_terms = $1,
        signed_name = $2,
        signed_at = $3,
        signature_image_key = $4,
        final_pdf_key = $5,
        signer_ip = $6,
        signer_user_agent = $7,
        status = 'signed',
        updated_at = NOW()
      WHERE id = $8
      `,
      [
        true,
        signedName ?? null,
        signedAt,
        signatureImageKey,
        finalPdfKey,
        req.ip ?? null,
        req.get("user-agent") ?? null,
        contract.id,
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      message: "Contrat signé avec succès",
      contractId: contract.id,
      finalPdfKey,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error signing contract:", err);

    return res.status(500).json({
      error: "Erreur serveur lors de la signature du contrat",
    });
  } finally {
    client.release();
  }
});


export default router;