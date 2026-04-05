import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

type SavedPdfPage = {
  page: number;
  imageUrl: string;
};

type ConvertPdfToWebpFilesResult = {
  folderId: string;
  pages: SavedPdfPage[];
};

export async function convertPdfBufferToWebpFiles(
  pdfBuffer: Buffer,
  scale = 1.5
): Promise<ConvertPdfToWebpFilesResult> {
  console.log("1. convertPdfBufferToWebpFiles called");

  const folderId = crypto.randomUUID();

  const outputDir = path.join(
    process.cwd(),
    "public",
    "generated-contracts",
    folderId
  );

  console.log("2. outputDir =", outputDir);

  await fs.mkdir(outputDir, { recursive: true });
  console.log("3. outputDir created");

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  console.log("4. PDF loaded, numPages =", pdf.numPages);

  const pages: SavedPdfPage[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    console.log(`5. starting page ${pageNum}`);

    const page = await pdf.getPage(pageNum);
    console.log(`6. got page ${pageNum}`);

    const viewport = page.getViewport({ scale });
    console.log(`7. viewport for page ${pageNum}`, {
      width: viewport.width,
      height: viewport.height,
    });

    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );
    console.log(`8. canvas created for page ${pageNum}`);

    const context = canvas.getContext("2d");
    console.log(`9. context created for page ${pageNum}`);

    await page.render({
      canvas: canvas as any,
      canvasContext: context as any,
      viewport,
    }).promise;
    console.log(`10. rendered page ${pageNum}`);

    const webpBuffer = await canvas.encode("webp", 80);
    console.log(`11. encoded page ${pageNum}, size = ${webpBuffer.length}`);

    const fileName = `page-${pageNum}.webp`;
    const filePath = path.join(outputDir, fileName);

    await fs.writeFile(filePath, webpBuffer);
    console.log(`12. saved page ${pageNum} to ${filePath}`);

    pages.push({
      page: pageNum,
      imageUrl: `/generated-contracts/${folderId}/${fileName}`,
    });
  }

  console.log("13. conversion complete");

  return {
    folderId,
    pages,
  };
}