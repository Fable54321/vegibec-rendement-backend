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

function normalizePin(pin: unknown): string | null {
  if (pin === undefined || pin === null) {
    return null;
  }

  const normalizedPin = String(pin).trim().replace(/\s+/g, "");

  if (normalizedPin === "" || !/^\d{1,10}$/.test(normalizedPin)) {
    return null;
  }

  return normalizedPin;
}

function getUnsignedSessionContractIds(session: {
  contracts: Array<{ contractId: number; status: string }>;
}) {
  return session.contracts
    .filter((contract) => contract.status !== "signed")
    .map((contract) => contract.contractId);
}



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
        pin,
        nas,
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
    const pin = req.body?.pin;
    const normalizedPin = normalizePin(pin);

    if (!normalizedPin) {
      return res.status(400).json({
        error: "PIN invalide",
        details: "Le PIN doit contenir uniquement des chiffres.",
      });
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
    const pin = req.body?.pin;
    const normalizedPin = normalizePin(pin);

    if (!normalizedPin) {
      return res.status(400).json({
        error: "PIN invalide",
        details: "Le PIN doit contenir uniquement des chiffres.",
      });
    }

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
        fwi.matricula,
        fwi.contract_type,
        fwi.nas,
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
    const { acceptedTerms, signedName } = req.body;

    if (!Number.isInteger(contractId) || contractId <= 0) {
      return res.status(400).json({ error: "ID de contrat invalide" });
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
        final_pdf_key,
        session_signature_key
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

    if (!contract.session_signature_key) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Aucune signature de session trouvée pour ce contrat" });
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

    const signatureBuffer = await getBufferFromS3(contract.session_signature_key);

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
    const { signatureDataUrl } = req.body ?? {};
    const pin = req.body?.pin;
    const normalizedPin = normalizePin(pin);

    if (!normalizedPin) {
      return res.status(400).json({
        error: "PIN invalide",
        details: "Le PIN doit contenir uniquement des chiffres.",
      });
    }

    const fullWorker = await getWorkerFullByPin(normalizedPin);
    const session = await buildContractSession(fullWorker);
    const unsignedContractIds = getUnsignedSessionContractIds(session);

    // Handle signature upload if provided
    if (
      signatureDataUrl &&
      typeof signatureDataUrl === "string" &&
      unsignedContractIds.length > 0
    ) {
      const base64Data = signatureDataUrl.replace(/^data:image\/png;base64,/, "");
      const signatureBuffer = Buffer.from(base64Data, "base64");

      if (!signatureBuffer.length) {
        return res.status(400).json({ error: "Signature invalide" });
      }

      const timestamp = Date.now();
      const sessionSignatureKey = `workers/${fullWorker.user_id}/session_${timestamp}_signature.png`;

      await uploadBufferToS3({
        key: sessionSignatureKey,
        buffer: signatureBuffer,
        contentType: "image/png",
      });

      // Attach this session signature only to the current contract set.
      await pool.query(
        `
        UPDATE worker_contracts
        SET session_signature_key = $1,
            updated_at = NOW()
        WHERE id = ANY($2::int[])
          AND user_id = $3
          AND status != 'signed'
        `,
        [sessionSignatureKey, unsignedContractIds, fullWorker.user_id]
      );
    }

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


router.post("/foreign-worker-contract/session/sign-all/by-pin", async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const { acceptedTerms, signedName } = req.body ?? {};
    const pin = req.body?.pin;
    const normalizedPin = normalizePin(pin);

    if (!normalizedPin) {
      return res.status(400).json({
        error: "PIN invalide",
        details: "Le PIN doit contenir uniquement des chiffres.",
      });
    }

    if (!acceptedTerms) {
      return res.status(400).json({
        error: "Vous devez accepter les contrats avant de signer",
      });
    }

    const signedNameValue =
      typeof signedName === "string" ? signedName.trim() : "";

    if (!signedNameValue) {
      return res.status(400).json({
        error: "Le nom du signataire est requis",
      });
    }

    const fullWorker = await getWorkerFullByPin(normalizedPin);
    const session = await buildContractSession(fullWorker);
    const unsignedContractIds = getUnsignedSessionContractIds(session);

    if (unsignedContractIds.length === 0) {
      return res.status(400).json({
        error: "Aucun contrat Ã  signer",
      });
    }

    const contractsResult = await client.query(
      `
      SELECT
        id,
        user_id,
        contract_slug,
        status,
        draft_pdf_key,
        session_signature_key
      FROM worker_contracts
      WHERE id = ANY($1::int[])
        AND user_id = $2
        AND status != 'signed'
      ORDER BY array_position($1::int[], id)
      `,
      [unsignedContractIds, fullWorker.user_id]
    );

    const contracts = contractsResult.rows;

    if (contracts.length === 0) {
      return res.status(400).json({
        error: "Aucun contrat à signer",
      });
    }

    const missingSignature = contracts.find(
      (contract) => !contract.session_signature_key
    );

    if (missingSignature) {
      return res.status(400).json({
        error: "Aucune signature de session trouvée",
      });
    }

    const sessionSignatureKey = contracts[0].session_signature_key;
    const signatureBuffer = await getBufferFromS3(sessionSignatureKey);

    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
      UPDATE worker_contracts
      SET session_signature_key = $1,
          updated_at = NOW()
      WHERE id = ANY($2::int[])
        AND user_id = $3
        AND status != 'signed'
      `,
      [sessionSignatureKey, unsignedContractIds, fullWorker.user_id]
    );

    const signedAt = new Date();
    const signedContracts = [];

    for (const contract of contracts) {
      if (!contract.draft_pdf_key) {
        const access = await getContractAccessDetails(contract.id);
        contract.draft_pdf_key = access.draftPdfKey;
      }

      if (!contract.draft_pdf_key) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.status(400).json({
          error: `Aucun PDF brouillon pour le contrat ${contract.contract_slug}`,
        });
      }

      const draftPdfBuffer = await getBufferFromS3(contract.draft_pdf_key);

      const finalPdfBuffer = await applySignatureToContract({
        pdfBuffer: draftPdfBuffer,
        contractSlug: contract.contract_slug,
        signatureBuffer,
        signedAt,
        signedName: signedNameValue,
      });

      const signatureImageKey = `contracts/${contract.user_id}/${contract.id}/signature.png`;
      const finalPdfKey = `contracts/${contract.user_id}/${contract.id}/final.pdf`;

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
          accepted_terms = true,
          signed_name = $1,
          signed_at = $2,
          signature_image_key = $3,
          final_pdf_key = $4,
          signer_ip = $5,
          signer_user_agent = $6,
          status = 'signed',
          updated_at = NOW()
        WHERE id = $7
        `,
        [
          signedNameValue,
          signedAt,
          signatureImageKey,
          finalPdfKey,
          req.ip ?? null,
          req.get("user-agent") ?? null,
          contract.id,
        ]
      );

      signedContracts.push({
        contractId: contract.id,
        slug: contract.contract_slug,
        status: "signed",
        finalPdfKey,
      });
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(200).json({
      message: "Tous les contrats ont été signés avec succès",
      contracts: signedContracts,
    });
  } catch (err) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }
    console.error("Error signing all contracts:", err);

    return res.status(500).json({
      error: "Erreur serveur lors de la signature des contrats",
    });
  } finally {
    client.release();
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
