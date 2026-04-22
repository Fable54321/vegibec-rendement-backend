import { pool } from "../../db";
import {
  getRequiredContractSlugsForWorker,
  getContractTitle,
} from "./getRequiredContractSlugForWorker";
import { getSignedUrlForKey, uploadBufferToS3 } from "../../services/s3.services";
import {
  generateContractBuffer,
  getContractTemplateVersion,
} from "./generateContractBuffer";
import { employer } from "../DocumentInfo";

type WorkerContractStatus = "draft" | "signed";

type Worker = {
  user_id: number;
  contract_type?: string | null;
  [key: string]: any;
};

type ContractRow = {
  id: number;
  user_id: number;
  contract_slug: string;
  draft_pdf_key: string | null;
  final_pdf_key: string | null;
  status: WorkerContractStatus;
  template_version: string;
  created_at?: string | Date;
  updated_at?: string | Date;
  signed_at?: string | Date | null;
  worker_snapshot?: Worker | null;
  employer_snapshot?: Record<string, any> | null;
};

type SessionContract = {
  contractId: number;
  slug: string;
  title: string;
  status: WorkerContractStatus;
  templateVersion: string;
  accessUrl: string | null;
  isReady: boolean;
  reused: boolean;
  storageKey: string | null;
};

type ContractAccessDetails = {
  contractId: number;
  userId: number;
  slug: string;
  status: WorkerContractStatus;
  templateVersion: string;
  accessUrl: string;
  draftPdfKey: string | null;
  finalPdfKey: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  signedAt?: string | Date | null;
};

function getStorageKeyForContract(contract: {
  status: WorkerContractStatus;
  draft_pdf_key?: string | null;
  final_pdf_key?: string | null;
  storageKey?: string | null;
}) {
  if (contract.storageKey) {
    return contract.storageKey;
  }

  return contract.status === "signed" && contract.final_pdf_key
    ? contract.final_pdf_key
    : contract.draft_pdf_key ?? null;
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

function buildSessionContract(contract: ContractRow, reused: boolean): SessionContract {
  const storageKey = getStorageKeyForContract(contract);

  return {
    contractId: contract.id,
    slug: contract.contract_slug,
    title: getContractTitle(contract.contract_slug),
    status: contract.status,
    templateVersion: contract.template_version,
    accessUrl: null,
    isReady: Boolean(storageKey),
    reused,
    storageKey,
  };
}

async function getLatestExistingContractsBySlug(
  workerId: number,
  contractSlugs: string[]
) {
  if (contractSlugs.length === 0) {
    return new Map<string, ContractRow>();
  }

  const result = await pool.query<ContractRow>(
    `
    SELECT DISTINCT ON (contract_slug)
      id,
      user_id,
      contract_slug,
      draft_pdf_key,
      final_pdf_key,
      status,
      template_version
    FROM worker_contracts
    WHERE user_id = $1
      AND contract_slug = ANY($2::text[])
      AND status IN ('signed', 'draft')
    ORDER BY
      contract_slug,
      CASE WHEN status = 'signed' THEN 0 ELSE 1 END,
      updated_at DESC,
      id DESC
    `,
    [workerId, contractSlugs]
  );

  return new Map(result.rows.map((row) => [row.contract_slug, row] as const));
}

async function createDraftContractRecord({
  worker,
  contractSlug,
}: {
  worker: Worker;
  contractSlug: string;
}): Promise<ContractRow> {
  const effectiveSlug = normalizeMainContractSlug(worker, contractSlug);
  const templateVersion = getContractTemplateVersion({
    contractSlug: effectiveSlug,
  });

  const result = await pool.query<ContractRow>(
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
    RETURNING
      id,
      user_id,
      contract_slug,
      draft_pdf_key,
      final_pdf_key,
      status,
      template_version
    `,
    [
      worker.user_id,
      effectiveSlug,
      templateVersion,
      JSON.stringify(worker),
      JSON.stringify(employer),
    ]
  );

  return result.rows[0];
}

async function getStoredContractById(contractId: number) {
  const result = await pool.query<ContractRow>(
    `
    SELECT
      id,
      user_id,
      contract_slug,
      draft_pdf_key,
      final_pdf_key,
      status,
      template_version,
      created_at,
      updated_at,
      signed_at,
      worker_snapshot,
      employer_snapshot
    FROM worker_contracts
    WHERE id = $1
    LIMIT 1
    `,
    [contractId]
  );

  return result.rows[0] ?? null;
}

async function materializeDraftPdf(
  contract: ContractRow,
  workerOverride?: Worker
): Promise<ContractRow> {
  const existingStorageKey = getStorageKeyForContract(contract);

  if (existingStorageKey) {
    return contract;
  }

  if (contract.status === "signed") {
    throw new Error("Aucun PDF trouve pour ce contrat");
  }

  const worker = workerOverride ?? contract.worker_snapshot;

  if (!worker) {
    throw new Error("Impossible de generer le brouillon du contrat");
  }

  const { pdfBuffer } = await generateContractBuffer({
    worker,
    contractSlug: contract.contract_slug,
    employerSnapshot: contract.employer_snapshot ?? employer,
  });

  const draftPdfKey = `contracts/${contract.user_id}/${contract.id}/draft.pdf`;

  await uploadBufferToS3({
    key: draftPdfKey,
    buffer: pdfBuffer,
    contentType: "application/pdf",
  });

  const updateResult = await pool.query<Pick<ContractRow, "draft_pdf_key" | "updated_at">>(
    `
    UPDATE worker_contracts
    SET draft_pdf_key = $1,
        updated_at = NOW()
    WHERE id = $2
    RETURNING draft_pdf_key, updated_at
    `,
    [draftPdfKey, contract.id]
  );

  return {
    ...contract,
    draft_pdf_key: updateResult.rows[0]?.draft_pdf_key ?? draftPdfKey,
    updated_at: updateResult.rows[0]?.updated_at ?? contract.updated_at,
  };
}

export async function getContractAccessDetails(
  contractId: number
): Promise<ContractAccessDetails> {
  const contract = await getStoredContractById(contractId);

  if (!contract) {
    throw new Error("Contrat introuvable");
  }

  const readyContract = await materializeDraftPdf(contract);
  const storageKey = getStorageKeyForContract(readyContract);

  if (!storageKey) {
    throw new Error("Aucun PDF trouve pour ce contrat");
  }

  return {
    contractId: readyContract.id,
    userId: readyContract.user_id,
    slug: readyContract.contract_slug,
    status: readyContract.status,
    templateVersion: readyContract.template_version,
    accessUrl: await getSignedUrlForKey(storageKey),
    draftPdfKey: readyContract.draft_pdf_key,
    finalPdfKey: readyContract.final_pdf_key,
    createdAt: readyContract.created_at,
    updatedAt: readyContract.updated_at,
    signedAt: readyContract.signed_at,
  };
}

export async function getAccessUrlForPreparedContract(contract: {
  status: WorkerContractStatus;
  contractId: number;
  storageKey?: string | null;
}) {
  const storageKey = getStorageKeyForContract(contract);

  if (storageKey) {
    return getSignedUrlForKey(storageKey);
  }

  const accessDetails = await getContractAccessDetails(contract.contractId);
  return accessDetails.accessUrl;
}

export async function buildContractSession(fullWorker: Worker) {
  const requiredSlugs = [
    ...new Set(
      getRequiredContractSlugsForWorker(fullWorker).map((slug) =>
        normalizeMainContractSlug(fullWorker, slug)
      )
    ),
  ];

  const existingContractsBySlug = await getLatestExistingContractsBySlug(
    fullWorker.user_id,
    requiredSlugs
  );

  const contractRows: ContractRow[] = [];
  const sessionContracts: SessionContract[] = [];

  for (const slug of requiredSlugs) {
    const existingContract = existingContractsBySlug.get(slug);
    const contractRow =
      existingContract ??
      (await createDraftContractRecord({
        worker: fullWorker,
        contractSlug: slug,
      }));

    contractRows.push(contractRow);
    sessionContracts.push(buildSessionContract(contractRow, Boolean(existingContract)));
  }

  const currentIndex = sessionContracts.findIndex(
    (contract) => contract.status !== "signed"
  );

  if (currentIndex >= 0) {
    const currentContractRow = await materializeDraftPdf(
      contractRows[currentIndex],
      fullWorker
    );
    const currentContract = sessionContracts[currentIndex];

    currentContract.storageKey = getStorageKeyForContract(currentContractRow);
    currentContract.isReady = Boolean(currentContract.storageKey);
    currentContract.accessUrl = currentContract.storageKey
      ? await getSignedUrlForKey(currentContract.storageKey)
      : null;
  }

  return {
    worker: {
      userId: fullWorker.user_id,
      name: fullWorker.name,
      surname: fullWorker.surname,
      contractType: fullWorker.contract_type ?? null,
      pin: fullWorker.pin ?? null,
      birth_date: fullWorker.birth_date ?? null,
    },
    contracts: sessionContracts.map(({ storageKey, ...contract }) => contract),
    currentIndex,
    allSigned: currentIndex === -1,
  };
}
