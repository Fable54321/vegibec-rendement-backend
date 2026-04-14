import { pool } from "../../db";
import {
    getRequiredContractSlugsForWorker,
    getContractTitle
  } from "./getRequiredContractSlugForWorker";
import { getSignedUrlForKey, uploadBufferToS3 } from "../../services/s3.services";
import { generateContractBuffer } from "./generateContractBuffer";
import { employer } from "../DocumentInfo";


async function ensureContractPrepared({
  worker,
  contractSlug,
  includeSignedUrl,
}: {
  worker: {
    user_id: number;
    contract_type?: string | null;
    [key: string]: any;
  };
  contractSlug: string;
  includeSignedUrl: boolean;
}) {
  const workerId = worker.user_id;
  const effectiveSlug = normalizeMainContractSlug(worker, contractSlug);

  const signedResult = await pool.query(
    `
    SELECT id, final_pdf_key, status, template_version
    FROM worker_contracts
    WHERE user_id = $1
      AND contract_slug = $2
      AND status = 'signed'
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
    `,
    [workerId, effectiveSlug]
  );

  if (signedResult.rows.length > 0) {
    const row = signedResult.rows[0];
    return {
      contractId: row.id,
      slug: effectiveSlug,
      title: getContractTitle(effectiveSlug),
      status: row.status,
      templateVersion: row.template_version,
      accessUrl: includeSignedUrl
        ? await getSignedUrlForKey(row.final_pdf_key)
        : null,
      isReady: true,
      reused: true,
    };
  }

  const draftResult = await pool.query(
    `
    SELECT id, draft_pdf_key, status, template_version
    FROM worker_contracts
    WHERE user_id = $1
      AND contract_slug = $2
      AND status = 'draft'
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
    `,
    [workerId, effectiveSlug]
  );

  if (draftResult.rows.length > 0) {
    const row = draftResult.rows[0];
    return {
      contractId: row.id,
      slug: effectiveSlug,
      title: getContractTitle(effectiveSlug),
      status: row.status,
      templateVersion: row.template_version,
      accessUrl: includeSignedUrl
        ? await getSignedUrlForKey(row.draft_pdf_key)
        : null,
      isReady: true,
      reused: true,
    };
  }

  const { pdfBuffer, templateVersion } = await generateContractBuffer({
    worker,
    contractSlug: effectiveSlug,
  });

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
      effectiveSlug,
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

  return {
    contractId,
    slug: effectiveSlug,
    title: getContractTitle(effectiveSlug),
    status: "draft" as const,
    templateVersion,
    accessUrl: includeSignedUrl
      ? await getSignedUrlForKey(draftPdfKey)
      : null,
    isReady: true,
    reused: false,
  };
}

  function normalizeMainContractSlug(
  worker: { contract_type?: string | null },
  slug: string
) {
  if (slug === "PTET" || slug === "PTAS") {
    return worker.contract_type === "PTAS" ? "PTAS" : "PTET";
  }

  return slug;
}

export async function getAccessUrlForPreparedContract(contract: {
  status: "draft" | "signed";
  contractId: number;
}) {
  const result = await pool.query(
    `
    SELECT draft_pdf_key, final_pdf_key, status
    FROM worker_contracts
    WHERE id = $1
    LIMIT 1
    `,
    [contract.contractId]
  );

  if (result.rows.length === 0) {
    throw new Error("Contrat introuvable");
  }

  const row = result.rows[0];

  const keyToUse =
    row.status === "signed" && row.final_pdf_key
      ? row.final_pdf_key
      : row.draft_pdf_key;

  if (!keyToUse) {
    throw new Error("Aucun PDF trouvé pour ce contrat");
  }

  return getSignedUrlForKey(keyToUse);
}



export async function buildContractSession(fullWorker: any) {
  const requiredSlugs = [
    ...new Set(
      getRequiredContractSlugsForWorker(fullWorker).map((slug) =>
        normalizeMainContractSlug(fullWorker, slug)
      )
    ),
  ];

  const preparedContracts = [];

  for (const slug of requiredSlugs) {
    const prepared = await ensureContractPrepared({
      worker: fullWorker,
      contractSlug: slug,
      includeSignedUrl: false,
    });

    preparedContracts.push(prepared);
  }

  const currentIndex = preparedContracts.findIndex(
    (contract) => contract.status !== "signed"
  );

  if (currentIndex >= 0) {
    const currentContract = preparedContracts[currentIndex];

    if (!currentContract.accessUrl) {
      currentContract.accessUrl = await getAccessUrlForPreparedContract(currentContract);
    }

    const nextContract = preparedContracts[currentIndex + 1];
    if (nextContract && !nextContract.accessUrl) {
      nextContract.accessUrl = await getAccessUrlForPreparedContract(nextContract);
    }
  }

  return {
    worker: {
      userId: fullWorker.user_id,
      name: fullWorker.name,
      surname: fullWorker.surname,
      contractType: fullWorker.contract_type ?? null,
      pin: fullWorker.pin ?? null,
    },
    contracts: preparedContracts,
    currentIndex,
    allSigned: currentIndex === -1,
  };
}