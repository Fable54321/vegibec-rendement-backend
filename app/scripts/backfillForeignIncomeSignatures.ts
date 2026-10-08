import "dotenv/config";
import { pool } from "../db";
import { employer } from "../Utils/DocumentInfo";
import { applySignatureToContract } from "../Utils/GenerateContracts";
import {
  generateContractBuffer,
  getContractTemplateVersion,
} from "../Utils/ContractHelpers/generateContractBuffer";
import { getBufferFromS3, uploadBufferToS3 } from "../services/s3.services";

type BackfillCandidate = {
  user_id: number;
  signature_image_key: string | null;
  session_signature_key: string | null;
  signed_at: Date | string;
  signed_name: string | null;
  signer_ip: string | null;
  signer_user_agent: string | null;
  worker_snapshot: Record<string, any>;
  employer_snapshot: Record<string, any> | null;
};

type BackfillArgs = {
  apply: boolean;
  limit?: number;
  userId?: number;
};

function readArgs(): BackfillArgs {
  const result: BackfillArgs = { apply: false };

  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") {
      result.apply = true;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      const limit = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      result.limit = limit;
      continue;
    }

    if (arg.startsWith("--user-id=")) {
      const userId = Number(arg.slice("--user-id=".length));
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new Error("--user-id must be a positive integer");
      }
      result.userId = userId;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

async function getCandidates({ limit, userId }: BackfillArgs) {
  const values: number[] = [];
  const userFilter =
    userId === undefined
      ? ""
      : `AND source_contract.user_id = $${values.push(userId)}`;
  const limitClause =
    limit === undefined ? "" : `LIMIT $${values.push(limit)}`;

  const result = await pool.query<BackfillCandidate>(
    `
    WITH completed_workers AS (
      SELECT user_id
      FROM worker_contracts
      WHERE status = 'signed'
        AND NULLIF(BTRIM(final_pdf_key), '') IS NOT NULL
        AND contract_slug IN ('Imp-aut', 'Imp-con')
      GROUP BY user_id
      HAVING COUNT(DISTINCT contract_slug) = 2
    ),
    source_contracts AS (
      SELECT DISTINCT ON (wc.user_id)
        wc.user_id,
        wc.signature_image_key,
        wc.session_signature_key,
        wc.signed_at,
        wc.signed_name,
        wc.signer_ip,
        wc.signer_user_agent,
        wc.worker_snapshot,
        wc.employer_snapshot
      FROM worker_contracts wc
      INNER JOIN completed_workers completed
        ON completed.user_id = wc.user_id
      WHERE wc.status = 'signed'
        AND wc.signed_at IS NOT NULL
        AND wc.worker_snapshot IS NOT NULL
        AND (
          NULLIF(BTRIM(wc.signature_image_key), '') IS NOT NULL
          OR NULLIF(BTRIM(wc.session_signature_key), '') IS NOT NULL
        )
      ORDER BY wc.user_id, wc.signed_at DESC, wc.id DESC
    )
    SELECT source_contract.*
    FROM source_contracts source_contract
    WHERE NOT EXISTS (
      SELECT 1
      FROM worker_contracts foreign_income
      WHERE foreign_income.user_id = source_contract.user_id
        AND foreign_income.contract_slug = 'Rev-etr'
        AND foreign_income.status = 'signed'
    )
    ${userFilter}
    ORDER BY source_contract.user_id
    ${limitClause}
    `,
    values,
  );

  return result.rows;
}

async function backfillCandidate(candidate: BackfillCandidate, apply: boolean) {
  const signatureKey =
    candidate.signature_image_key?.trim() ||
    candidate.session_signature_key?.trim();

  if (!signatureKey) {
    throw new Error("missing reusable signature key");
  }

  if (!apply) {
    return { userId: candidate.user_id, contractId: null, backfilled: false };
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worker_contracts'), $1)",
      [candidate.user_id],
    );

    const existing = await client.query<{ id: number }>(
      `
      SELECT id
      FROM worker_contracts
      WHERE user_id = $1
        AND contract_slug = 'Rev-etr'
        AND status = 'signed'
      LIMIT 1
      `,
      [candidate.user_id],
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return {
        userId: candidate.user_id,
        contractId: existing.rows[0].id,
        backfilled: false,
      };
    }

    const draftResult = await client.query<{ id: number }>(
      `
      INSERT INTO worker_contracts (
        user_id,
        contract_slug,
        template_version,
        status,
        worker_snapshot,
        employer_snapshot,
        accepted_terms,
        session_signature_key
      )
      VALUES ($1, 'Rev-etr', $2, 'draft', $3::jsonb, $4::jsonb, false, $5)
      RETURNING id
      `,
      [
        candidate.user_id,
        getContractTemplateVersion({ contractSlug: "Rev-etr" }),
        JSON.stringify(candidate.worker_snapshot),
        JSON.stringify(candidate.employer_snapshot ?? employer),
        signatureKey,
      ],
    );
    const contractId = draftResult.rows[0].id;
    const draftPdfKey = `contracts/${candidate.user_id}/${contractId}/draft.pdf`;
    const signatureImageKey = `contracts/${candidate.user_id}/${contractId}/signature.png`;
    const finalPdfKey = `contracts/${candidate.user_id}/${contractId}/final.pdf`;

    const [{ pdfBuffer: draftPdfBuffer }, signatureBuffer] = await Promise.all([
      generateContractBuffer({
        worker: candidate.worker_snapshot,
        contractSlug: "Rev-etr",
        employerSnapshot: candidate.employer_snapshot ?? employer,
      }),
      getBufferFromS3(signatureKey),
    ]);
    const signedName =
      candidate.signed_name?.trim() ||
      [candidate.worker_snapshot.surname, candidate.worker_snapshot.name]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
        .join(" ");
    const signedAt = new Date(candidate.signed_at);
    const finalPdfBuffer = await applySignatureToContract({
      pdfBuffer: draftPdfBuffer,
      contractSlug: "Rev-etr",
      signatureBuffer,
      signedAt,
      signedName,
    });

    await Promise.all([
      uploadBufferToS3({
        key: draftPdfKey,
        buffer: draftPdfBuffer,
        contentType: "application/pdf",
      }),
      uploadBufferToS3({
        key: signatureImageKey,
        buffer: signatureBuffer,
        contentType: "image/png",
      }),
      uploadBufferToS3({
        key: finalPdfKey,
        buffer: finalPdfBuffer,
        contentType: "application/pdf",
      }),
    ]);

    await client.query(
      `
      UPDATE worker_contracts
      SET accepted_terms = true,
          signed_name = $1,
          signed_at = $2,
          signature_image_key = $3,
          draft_pdf_key = $4,
          final_pdf_key = $5,
          signer_ip = $6,
          signer_user_agent = $7,
          status = 'signed',
          updated_at = NOW()
      WHERE id = $8
      `,
      [
        signedName || null,
        signedAt,
        signatureImageKey,
        draftPdfKey,
        finalPdfKey,
        candidate.signer_ip,
        candidate.signer_user_agent,
        contractId,
      ],
    );

    await client.query("COMMIT");
    transactionStarted = false;
    return { userId: candidate.user_id, contractId, backfilled: true };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const args = readArgs();
  const candidates = await getCandidates(args);
  console.log(
    `${args.apply ? "Backfilling" : "Dry run:"} ${candidates.length} foreign-income form(s).`,
  );

  if (!args.apply) {
    console.log("Pass --apply to create and sign the forms.");
  }

  let backfilled = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    try {
      const result = await backfillCandidate(candidate, args.apply);
      if (result.backfilled) {
        backfilled += 1;
        console.log(
          `Backfilled user ${result.userId} as contract ${result.contractId}.`,
        );
      } else {
        console.log(`Would backfill user ${result.userId}.`);
      }
    } catch (error) {
      skipped += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Skipped user ${candidate.user_id}: ${message}`);
    }
  }

  console.log(`Done. Backfilled: ${backfilled}. Skipped: ${skipped}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
