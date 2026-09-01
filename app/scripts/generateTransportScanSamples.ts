import fs from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";
import { pool } from "../db";

type ClientAddress = { client_name: string; client_number: string | null; site_number: string | number | null; address: string; city: string; postal_code: string; province: string | null; country: string | null };
type Product = { id: number; full_name: string; product_code: string | null; weight: string | number | null };
type ManifestEntry = Awaited<ReturnType<typeof generateDocument>>;
const outputDirectory = path.join(process.cwd(), "public", "generated", "transport-samples");
const manifestPath = path.join(outputDirectory, "manifest.json");
const samplesToGenerate = 10;
const paper = { width: 612, height: 792 };
const black = rgb(0.08, 0.08, 0.08);
const grey = rgb(0.92, 0.92, 0.92);
const green = rgb(0.12, 0.42, 0.18);
const randomFrom = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)];
const truncate = (value: unknown, length: number) => String(value ?? "").slice(0, length);
const drawText = (page: PDFPage, font: PDFFont, text: unknown, x: number, y: number, size = 8, bold?: PDFFont) => page.drawText(String(text ?? ""), { x, y, size, font: bold ?? font, color: black });
const drawBarcode = (page: PDFPage, value: string, x: number, y: number, width: number, height: number) => {
  const bits = [...value].flatMap((character) => Number(character).toString(2).padStart(4, "0").split(""));
  const barWidth = width / (bits.length * 1.5);
  let cursor = x;
  bits.forEach((bit, index) => { const current = barWidth * (bit === "1" ? 1.3 : 0.65); if (index % 2 === 0 || bit === "1") page.drawRectangle({ x: cursor, y, width: current, height, color: black }); cursor += barWidth * 1.5; });
};

async function generateDocument(index: number, client: ClientAddress, products: Product[], usedTripNumbers: Set<string>) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([paper.width, paper.height]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let tripNumber: string;
  do tripNumber = String(11500 + Math.floor(Math.random() * 500));
  while (usedTripNumbers.has(tripNumber));
  usedTripNumbers.add(tripNumber);
  const po = String(2000000000 + Math.floor(Math.random() * 7999999999));
  const shippingDate = new Date(Date.now() + index * 86_400_000).toISOString().slice(0, 10);
  const rows = products.slice(0, 4 + (index % 3)).map((product, rowIndex) => {
    const pallets = 1 + ((index + rowIndex * 3) % 6);
    const perPallet = randomFrom([30, 40, 44, 49, 60, 80]);
    const quantity = pallets * perPallet;
    const unitWeight = Number(product.weight) || 0;
    return { ...product, pallets, perPallet, quantity, unitWeight, lineWeight: quantity * unitWeight, palletType: randomFrom(["Peco", "CPC", "Ordinaire"]) };
  });
  const totalPallets = rows.reduce((sum, row) => sum + row.pallets, 0);
  const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  const totalWeight = rows.reduce((sum, row) => sum + row.lineWeight, 0);

  page.drawRectangle({ x: 15, y: 15, width: paper.width - 30, height: paper.height - 30, borderColor: rgb(0.2, 0.2, 0.95), borderWidth: 1 });
  page.drawText("Vegibec", { x: 28, y: 718, size: 32, font: bold, color: green });
  drawText(page, regular, "Vegibec", 280, 752, 12, bold); drawText(page, regular, "171 Rang Ste-Sophie", 266, 737, 8);
  drawText(page, regular, "OKA, Québec, Canada, J0N 1E0", 245, 725, 8); drawText(page, regular, "Téléphone (450) 596-0568", 250, 713, 7);
  drawText(page, regular, "Chargement voyage", 438, 752, 13); drawText(page, regular, "No Voyage", 470, 733, 12); drawText(page, regular, tripNumber, 493, 709, 16, bold);
  page.drawLine({ start: { x: 25, y: 690 }, end: { x: 587, y: 690 }, thickness: 2, color: black });

  page.drawRectangle({ x: 25, y: 646, width: 562, height: 34, borderColor: black, borderWidth: 1 });
  [105, 270, 500].forEach((x) => page.drawLine({ start: { x, y: 646 }, end: { x, y: 680 }, thickness: 1, color: black }));
  drawText(page, regular, "Shipping / Chargé", 28, 667, 7, bold); drawText(page, regular, shippingDate, 48, 652, 8);
  drawText(page, regular, "Sold by / Vendeur", 150, 667, 7, bold); drawText(page, regular, "Claudia Moreno", 155, 652, 8);
  drawText(page, regular, "Carrier / Transporteur", 340, 667, 7, bold); drawText(page, regular, "PICK UP", 395, 652, 8);
  drawText(page, regular, "Truck temp", 530, 667, 7, bold); drawText(page, regular, "36°", 546, 652, 8);

  drawText(page, regular, `Sold to :  ${client.client_number ?? ""} - ${truncate(client.client_name, 34)}`, 25, 625, 8, bold);
  drawText(page, regular, truncate(client.address, 45), 70, 610, 8); drawText(page, regular, `${client.city}, ${client.province ?? "QC"}`, 70, 597, 8); drawText(page, regular, `${client.postal_code} ${client.country ?? "Canada"}`, 70, 584, 8);
  drawText(page, regular, `Shipped to :  ${client.client_number ?? ""} - ${truncate(client.client_name, 30)}`, 315, 625, 8, bold);
  drawText(page, regular, truncate(client.address, 38), 366, 610, 8); drawText(page, regular, `${client.city}, ${client.province ?? "QC"} ${client.postal_code}`, 366, 597, 8);
  drawText(page, regular, "Bon Com.:", 478, 571, 9, bold); drawText(page, regular, po.slice(-6), 545, 568, 14, bold); drawBarcode(page, po, 480, 520, 95, 38);
  drawText(page, regular, `No client:  ${client.client_number ?? "—"}`, 25, 560, 8); drawText(page, regular, `PO:  ${po}`, 155, 560, 8, bold);

  drawText(page, regular, "Chargement #:   1", 25, 500, 9, bold); drawText(page, regular, "Chargé chez:   Vegibec", 265, 500, 9, bold);
  const columns = [25, 92, 155, 385, 465, 535];
  ["Code", "Lot #", "Item", "Qté à charger", "Qté chargé", "Palette"].forEach((heading, headingIndex) => drawText(page, regular, heading, columns[headingIndex], 477, 7, bold));
  let y = 455;
  rows.forEach((row) => {
    drawText(page, regular, row.product_code ?? "—", columns[0], y, 8);
    drawText(page, regular, String(26290000 + row.id), columns[1], y, 7);
    drawText(page, regular, truncate(row.full_name, 43), columns[2], y, 7.5);
    drawText(page, regular, `${row.pallets}x${row.perPallet}`, columns[3], y, 8, bold);
    page.drawRectangle({ x: columns[4], y: y - 4, width: 45, height: 18, borderColor: black, borderWidth: 0.8 });
    drawText(page, regular, `${row.pallets} ${row.palletType}`, columns[5], y, 8, bold);
    y -= 32;
  });
  page.drawRectangle({ x: 25, y: y - 2, width: 562, height: 22, color: grey });
  drawText(page, regular, "Poids total", 28, y + 5, 8, bold); drawText(page, regular, Math.round(totalWeight).toLocaleString("fr-CA"), 95, y + 5, 8, bold);
  drawText(page, regular, "Total", 270, y + 5, 8, bold); drawText(page, regular, totalQuantity.toLocaleString("fr-CA"), 390, y + 5, 8, bold); drawText(page, regular, totalPallets.toFixed(2), 520, y + 5, 8, bold);

  drawText(page, regular, "Carrier:", 25, 165, 8, bold); page.drawLine({ start: { x: 95, y: 164 }, end: { x: 330, y: 164 }, thickness: 0.8, color: black });
  drawText(page, regular, `Quantité total chargé:     ${totalQuantity.toLocaleString("fr-CA")}`, 375, 150, 8, bold);
  drawText(page, regular, `Poids total:                       ${Math.round(totalWeight).toLocaleString("fr-CA")}`, 375, 126, 8, bold);
  drawText(page, regular, `TOTAL PALETTES:                 ${totalPallets}`, 375, 102, 9, bold);
  drawText(page, regular, "Signature:", 25, 45, 8, bold); page.drawLine({ start: { x: 85, y: 44 }, end: { x: 330, y: 44 }, thickness: 0.8, color: black });

  const filename = `chargement-test-${String(index + 1).padStart(2, "0")}-${tripNumber}.pdf`;
  await fs.writeFile(path.join(outputDirectory, filename), await pdf.save());
  return { filename, tripNumber, client: client.client_name, address: `${client.address}, ${client.city} ${client.postal_code}`, totalPallets, totalQuantity, totalWeight: Math.round(totalWeight), rows: rows.map((row) => ({ code: row.product_code, product: row.full_name, quantityToLoad: `${row.pallets}x${row.perPallet}`, quantity: row.quantity, pallets: row.pallets, palletType: row.palletType, unitWeight: row.unitWeight })) };
}

async function main() {
  await fs.mkdir(outputDirectory, { recursive: true });
  let existingManifest: ManifestEntry[] = [];
  try { existingManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  const clients = await pool.query<ClientAddress>(`SELECT c.name AS client_name, c.client_number, a.site_number, a.address, a.city, a.postal_code, a.province, a.country FROM sales.clients c JOIN sales.clients_addresses a ON a.client_id = c.id WHERE a.address IS NOT NULL AND a.city IS NOT NULL AND a.postal_code IS NOT NULL ORDER BY random() LIMIT $1`, [samplesToGenerate]);
  const products = await pool.query<Product>(`SELECT id, full_name, product_code, weight FROM public.finished_product WHERE is_active = true AND product_code IS NOT NULL AND weight IS NOT NULL AND weight > 0 ORDER BY random() LIMIT 60`);
  if (clients.rows.length < samplesToGenerate || products.rows.length < 10) throw new Error("Not enough clients, addresses, or positive-weight products to generate samples.");

  const usedTripNumbers = new Set(existingManifest.map((entry) => entry.tripNumber));
  const generated: ManifestEntry[] = [];
  for (let sampleIndex = 0; sampleIndex < samplesToGenerate; sampleIndex++) {
    const documentIndex = existingManifest.length + sampleIndex;
    const productOffset = sampleIndex * 5;
    const orderedProducts = [...products.rows.slice(productOffset), ...products.rows.slice(0, productOffset)];
    generated.push(await generateDocument(documentIndex, clients.rows[sampleIndex], orderedProducts, usedTripNumbers));
  }
  const manifest = [...existingManifest, ...generated];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Generated ${generated.length} new documents (${manifest.length} total) in ${outputDirectory}`);
  await pool.end();
}

void main().catch(async (error) => { console.error(error); await pool.end(); process.exitCode = 1; });
