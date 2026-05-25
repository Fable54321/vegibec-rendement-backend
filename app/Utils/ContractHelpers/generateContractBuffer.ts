
import {
  generatePTASContract,
  generatePTETContract,
  generate0AuContract,
  generate0AvContract,
} from "../GenerateContracts";
import { generate0LoContract } from "../Generate0LoContract";
import { generateAutdedContract } from "../GenerateAutDed";
import { generateAutlavContract } from "../GenerateAutLav";
import { generateAutretContract } from "../generateAutretContract";
import { generateImpAutContract } from "../GenerateImpAut";
import { generateImpCons } from "../GenerateImpCons";
import { generatePolBrisContract } from "../GeneratePolBriscontract";
import { generatePolHarcContract } from "../GeneratePolHarcContract";
import { generatepolProtContract } from "../GeneratePolProtContract";
import { generatepolVioContract } from "../GeneratePolVio";
import {
  employer as defaultEmployer,
  getJobDescription,
} from "../../Utils/DocumentInfo";

export function getContractTemplateVersion({
  contractSlug,
}: {
  contractSlug: string;
}) {
  if (contractSlug === "PTAS") {
    return "2026-ptas-v1";
  }

  if (contractSlug === "PTET") {
    return "2026-ptet-v1";
  }

  if (contractSlug === "0Au") {
    return "2026-0Au-v1";
  }

  if (contractSlug === "0Av") {
    return "2026-0Av-v1";
  }

  if (contractSlug === "0Lo") {
    return "2026-0Lo-v1";
  }

  if (contractSlug === "Aut-ded") {
    return "2026-autded-v1";
  }

  if (contractSlug === "Aut-ret") {
    return "2026-autret-v1";
  }

  if (contractSlug === "Aut-lav") {
    return "2026-autlav-v1";
  }

  if (contractSlug === "Imp-aut") {
    return "2026-impaut-v1";
  }

  if (contractSlug === "Imp-con") {
    return "2026-icon-v1";
  }

  if (contractSlug === "Pol-bris") {
    return "2026-pol-bris-v1";
  }

  if (contractSlug === "Pol-harc") {
    return "2026-pol-harc-v1";
  }

  if (contractSlug === "Pol-prot") {
    return "2026-pol-prot-v1";
  }

  if (contractSlug === "Pol-vio") {
    return "2026-pol-vio-v1";
  }

  throw new Error(`Slug de contrat invalide: ${contractSlug}`);
}

export async function generateContractBuffer({
  worker,
  contractSlug,
  employerSnapshot,
}: {
  worker: any;
  contractSlug: string;
  employerSnapshot?: any;
}): Promise<{ pdfBuffer: Buffer; templateVersion: string }> {
  let pdfBuffer: Buffer | null = null;
  const templateVersion = getContractTemplateVersion({ contractSlug });
  const employer = employerSnapshot ?? defaultEmployer;

  if (contractSlug === "PTAS") {
    pdfBuffer = await generatePTASContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "PTET") {
    pdfBuffer = await generatePTETContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "0Au") {
    pdfBuffer = await generate0AuContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "0Av") {
    pdfBuffer = await generate0AvContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "0Lo") {
    pdfBuffer = await generate0LoContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Aut-ded") {
    pdfBuffer = await generateAutdedContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Aut-ret") {
    pdfBuffer = await generateAutretContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Aut-lav") {
    pdfBuffer = await generateAutlavContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Imp-aut") {
    pdfBuffer = await generateImpAutContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Imp-con") {
    pdfBuffer = await generateImpCons({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Pol-bris") {
    pdfBuffer = await generatePolBrisContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Pol-harc") {
    pdfBuffer = await generatePolHarcContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Pol-prot") {
    pdfBuffer = await generatepolProtContract({
      worker,
      employer,
      getJobDescription,
    });
  } else if (contractSlug === "Pol-vio") {
    pdfBuffer = await generatepolVioContract({
      worker,
      employer,
      getJobDescription,
    });
  }

  if (!pdfBuffer) {
    throw new Error(
      `Echec de generation pour ${contractSlug}: template ou buffer manquant`
    );
  }

  return { pdfBuffer, templateVersion };
}
