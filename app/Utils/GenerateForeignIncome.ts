import fs from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";

type Worker = {
  name?: string | null;
  surname?: string | null;
  nas?: string | null;
};

export const generateForeignIncomeContract = async ({
  worker,
}: {
  worker: Worker;
}): Promise<Buffer> => {
  const templatePath = path.join(
    process.cwd(),
    "public",
    "templates",
    "Formulaire revenus étrangers 2025.pdf",
  );
  const templateBytes = await fs.readFile(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes, {
    ignoreEncryption: true,
  });
  const form = pdfDoc.getForm();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const workerName = [worker.surname, worker.name]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(" ");

  form.getTextField("Nom du travailleur").setText(workerName);
  form.getTextField("dassurance sociale").setText(worker.nas?.trim() ?? "");
  form.getTextField("Date").setText("");
  form.getTextField("Texte3").setText("");
  form.updateFieldAppearances(font);
  form.flatten();

  return Buffer.from(await pdfDoc.save());
};
