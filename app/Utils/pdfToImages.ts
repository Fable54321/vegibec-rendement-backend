import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

type PdfPageImage = {
  page: number;
  imageBase64: string;
};

export async function convertPdfBufferToJpgPages(
  pdfBuffer: Buffer,
  scale = 2
): Promise<PdfPageImage[]> {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const pages: PdfPageImage[] = [];

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

const webpBuffer = await canvas.encode("webp", 100);

    pages.push({
      page: pageNum,
      imageBase64: `data:image/webp;base64,${webpBuffer.toString("base64")}`,
    });
  }

  return pages;
}