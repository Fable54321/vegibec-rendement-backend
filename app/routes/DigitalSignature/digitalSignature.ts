import { Router } from "express";
import { pool } from "../../db";
import { uploadBufferToS3, getBufferFromS3 } from "../../services/s3.services"
import { applySignatureToContract } from "../../Utils/GenerateContracts";
import { getWorkerFullByPin } from "../../Utils/ContractHelpers/getRequiredContractSlugForWorker";
import {
  buildContractSession,
  getContractAccessDetails,
} from "../../Utils/ContractHelpers/buildContracSession";


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
      [pin]
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
      [pin]
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
      [pin]
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
        fwi.matricula,
        fwi.contract_type
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

    let draftPdfKey = contract.draft_pdf_key;

    if (!draftPdfKey) {
      const access = await getContractAccessDetails(contractId);
      draftPdfKey = access.draftPdfKey;
    }

    if (!draftPdfKey) {
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

    const draftPdfBuffer = await getBufferFromS3(draftPdfKey);

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







router.post("/foreign-worker-contract/session/by-pin", async (req, res) => {
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

    const fullWorker = await getWorkerFullByPin(pin);
    const session = await buildContractSession(fullWorker);

    return res.status(200).json(session);
  } catch (err) {
    console.error("Error starting contract session:", err);

    if (
      err instanceof Error &&
      err.message === "Aucun travailleur trouvé avec ce PIN"
    ) {
      return res.status(404).json({
        error: "Aucun travailleur trouvé avec ce PIN",
      });
    }

    if (
      err instanceof Error &&
      (err.message === "Contrat introuvable" ||
        err.message === "Aucun PDF trouvé pour ce contrat" ||
        err.message === "Aucun PDF trouve pour ce contrat")
    ) {
      return res.status(404).json({
        error: err.message,
      });
    }

    return res.status(500).json({
      error: "Erreur serveur lors de la préparation de la session",
    });
  }
});


router.get("/foreign-worker-contract/:id/access", async (req, res) => {
  try {
    const contractId = Number(req.params.id);

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: "ID de contrat invalide" });
    }


    const access = await getContractAccessDetails(contractId);
    return res.status(200).json({
      contractId: access.contractId,
      slug: access.slug,
      status: access.status,
      templateVersion: access.templateVersion,
      accessUrl: access.accessUrl,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === "Contrat introuvable" ||
        err.message === "Aucun PDF trouve pour ce contrat")
    ) {
      return res.status(404).json({ error: err.message });
    }

    console.error("Error getting contract access:", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la récupération du contrat",
    });
  }
});


export default router;
