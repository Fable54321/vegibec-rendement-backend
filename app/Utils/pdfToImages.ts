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
  const folderId = crypto.randomUUID();

  const outputDir = path.join(
    process.cwd(),
    "public",
    "generated-contracts",
    folderId
  );

  await fs.mkdir(outputDir, { recursive: true });

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const pages: SavedPdfPage[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );

    const context = canvas.getContext("2d");

    await page.render({
      canvas: canvas as any,
      canvasContext: context as any,
      viewport,
    }).promise;

    const webpBuffer = await canvas.encode("webp", 80);

    const fileName = `page-${pageNum}.webp`;
    const filePath = path.join(outputDir, fileName);

    await fs.writeFile(filePath, webpBuffer);

    pages.push({
      page: pageNum,
      imageUrl: `/generated-contracts/${folderId}/${fileName}`,
    });
  }

  return {
    folderId,
    pages,
  };
}