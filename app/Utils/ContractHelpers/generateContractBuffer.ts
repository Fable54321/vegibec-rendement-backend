
import { generatePTASContract, generatePTETContract, generate0AuContract, generate0AvContract } from "../GenerateContracts";
import { generate0LoContract } from "../Generate0LoContract";
import { generateAutdedContract } from "../GenerateAutDed";
import { generateAutretContract } from "../generateAutretContract";
import { generatePolBrisContract } from "../GeneratePolBriscontract"
import { generatePolHarcContract } from "../GeneratePolHarcContract"
import { generatepolProtContract } from "../GeneratePolProtContract"
import { generatepolVioContract } from "../GeneratePolVio";
import { employer, getJobDescription } from "../../Utils/DocumentInfo";


export async function generateContractBuffer({
  worker,
  contractSlug,
}: {
  worker: any;
  contractSlug: string;
}): Promise<{ pdfBuffer: Buffer; templateVersion: string }> {
  let pdfBuffer: Buffer | null = null;
  let templateVersion: string | null = null;

  if (contractSlug === "PTAS" || contractSlug === "PTET") {
    if (worker.contract_type === "PTAS") {
      templateVersion = "2026-ptas-v1";
      pdfBuffer = await generatePTASContract({
        worker,
        employer,
        getJobDescription,
      });
    } else if (worker.contract_type === "PTET") {
      templateVersion = "2026-ptet-v1";
      pdfBuffer = await generatePTETContract({
        worker,
        employer,
        getJobDescription,
      });
    }
  } else if (contractSlug === "0Au") {
    templateVersion = "2026-0Au-v1";
    pdfBuffer = await generate0AuContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "0Av") {
    templateVersion = "2026-0Av-v1";
    pdfBuffer = await generate0AvContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "0Lo") {
    templateVersion = "2026-0Lo-v1";
    pdfBuffer = await generate0LoContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Aut-ded") {
    templateVersion = "2026-autded-v1";
    pdfBuffer = await generateAutdedContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Aut-ret") {
    templateVersion = "2026-autret-v1";
    pdfBuffer = await generateAutretContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Pol-bris") {
    templateVersion = "2026-pol-bris-v1";
    pdfBuffer = await generatePolBrisContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Pol-harc") {
    templateVersion = "2026-pol-harc-v1";
    pdfBuffer = await generatePolHarcContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Pol-prot") {
    templateVersion = "2026-pol-prot-v1";
    pdfBuffer = await generatepolProtContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Pol-vio") {
    templateVersion = "2026-pol-vio-v1";
    pdfBuffer = await generatepolVioContract({
      worker,
      employer,
      getJobDescription,
    });
  } else {
    throw new Error(`Slug de contrat invalide: ${contractSlug}`);
  }

  if (!pdfBuffer || !templateVersion) {
    throw new Error(
      `Échec de génération pour ${contractSlug}: template ou buffer manquant`
    );
  }

  return { pdfBuffer, templateVersion };
}