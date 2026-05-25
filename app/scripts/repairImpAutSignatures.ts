import "dotenv/config";
import { pool } from "../db";
import { applySignatureToContract } from "../Utils/GenerateContracts";
import { generateContractBuffer } from "../Utils/ContractHelpers/generateContractBuffer";
import { getBufferFromS3, uploadBufferToS3 } from "../services/s3.services";

type SignedImpAutContract = {
  id: number;
  user_id: number;
  draft_pdf_key: string | null;
  final_pdf_key: string | null;
  signature_image_key: string | null;
  session_signature_key: string | null;
  signed_at: Date | string | null;
  signed_name: string | null;
  worker_snapshot: Record<string, unknown> | null;
  employer_snapshot: Record<string, unknown> | null;
};

type RepairArgs = {
  apply: boolean;
  limit?: number;
  contractId?: number;
};

function readArgs(): RepairArgs {
  const args = process.argv.slice(2);
  const result: RepairArgs = { apply: false };

  for (const arg of args) {
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

    if (arg.startsWith("--contract-id=")) {
      const contractId = Number(arg.slice("--contract-id=".length));
      if (!Number.isInteger(contractId) || contractId <= 0) {
        throw new Error("--contract-id must be a positive integer");
      }
      result.contractId = contractId;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

async function getSignedImpAutContracts({
  limit,
  contractId,
}: Pick<RepairArgs, "limit" | "contractId">) {
  const filters = ["contract_slug = 'Imp-aut'", "status = 'signed'"];
  const values: Array<number> = [];

  if (contractId !== undefined) {
    values.push(contractId);
    filters.push(`id = $${values.length}`);
  }

  let query = `
    SELECT
      id,
      user_id,
      draft_pdf_key,
      final_pdf_key,
      signature_image_key,
      session_signature_key,
      signed_at,
      signed_name,
      worker_snapshot,
      employer_snapshot
    FROM worker_contracts
    WHERE ${filters.join(" AND ")}
    ORDER BY id
  `;

  if (limit !== undefined) {
    values.push(limit);
    query += ` LIMIT $${values.length}`;
  }

  const result = await pool.query<SignedImpAutContract>(query, values);
  return result.rows;
}

async function getDraftPdfBuffer(contract: SignedImpAutContract) {
  if (contract.draft_pdf_key) {
    return getBufferFromS3(contract.draft_pdf_key);
  }

  if (!contract.worker_snapshot) {
    throw new Error("missing draft_pdf_key and worker_snapshot");
  }

  const { pdfBuffer } = await generateContractBuffer({
    worker: contract.worker_snapshot,
    contractSlug: "Imp-aut",
    employerSnapshot: contract.employer_snapshot,
  });

  return pdfBuffer;
}

async function repairContract(contract: SignedImpAutContract, apply: boolean) {
  const signatureKey = contract.signature_image_key ?? contract.session_signature_key;
  const finalPdfKey =
    contract.final_pdf_key ?? `contracts/${contract.user_id}/${contract.id}/final.pdf`;

  if (!signatureKey) {
    throw new Error("missing signature_image_key and session_signature_key");
  }

  if (!contract.signed_at) {
    throw new Error("missing signed_at");
  }

  if (!apply) {
    return {
      id: contract.id,
      finalPdfKey,
      signatureKey,
      repaired: false,
    };
  }

  const [draftPdfBuffer, signatureBuffer] = await Promise.all([
    getDraftPdfBuffer(contract),
    getBufferFromS3(signatureKey),
  ]);

  const finalPdfBuffer = await applySignatureToContract({
    pdfBuffer: draftPdfBuffer,
    contractSlug: "Imp-aut",
    signatureBuffer,
    signedAt: new Date(contract.signed_at),
    signedName: contract.signed_name ?? undefined,
  });

  await uploadBufferToS3({
    key: finalPdfKey,
    buffer: finalPdfBuffer,
    contentType: "application/pdf",
  });

  if (!contract.final_pdf_key) {
    await pool.query(
      `
      UPDATE worker_contracts
      SET final_pdf_key = $1,
          updated_at = NOW()
      WHERE id = $2
      `,
      [finalPdfKey, contract.id],
    );
  }

  return {
    id: contract.id,
    finalPdfKey,
    signatureKey,
    repaired: true,
  };
}

async function main() {
  const args = readArgs();
  const contracts = await getSignedImpAutContracts(args);

  console.log(
    `${args.apply ? "Repairing" : "Dry run:"} ${contracts.length} signed Imp-aut contract(s).`,
  );

  if (!args.apply) {
    console.log("Pass --apply to overwrite each final PDF with both signature placements.");
  }

  let repairedCount = 0;
  let skippedCount = 0;

  for (const contract of contracts) {
    try {
      const result = await repairContract(contract, args.apply);
      if (result.repaired) {
        repairedCount += 1;
        console.log(`Repaired contract ${result.id}: ${result.finalPdfKey}`);
      } else {
        console.log(
          `Would repair contract ${result.id}: ${result.finalPdfKey} using ${result.signatureKey}`,
        );
      }
    } catch (error) {
      skippedCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Skipped contract ${contract.id}: ${message}`);
    }
  }

  console.log(`Done. Repaired: ${repairedCount}. Skipped: ${skippedCount}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
