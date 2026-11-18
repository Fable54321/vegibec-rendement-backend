import fs from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";
import { pool } from "../db";

type ClientAddress = { client_id: number; address_id: number; client_name: string; client_number: string | null; site_number: string | number | null; address: string; city: string; postal_code: string; province: string | null; country: string | null };
type Product = { id: number; full_name: string; product_code: string; product_type: string | null; weight: string | number; qty_per_pallet: number };
type ManifestEntry = Awaited<ReturnType<typeof generateDocument>>;
const outputDirectory = path.join(process.cwd(), "public", "generated", "transport-samples");
const manifestPath = path.join(outputDirectory, "manifest.json");
const logoPath = path.join(process.cwd(), "app", "assets", "vegibec.png");
const requestedSampleCount = Number(process.env.TRANSPORT_SAMPLE_COUNT ?? 10);
const samplesToGenerate = Number.isSafeInteger(requestedSampleCount) && requestedSampleCount > 0 && requestedSampleCount <= 100 ? requestedSampleCount : 10;
const lowPalletBatch = process.env.TRANSPORT_SAMPLE_LOW_PALLETS === "true";
const requestedAddressIds = (process.env.TRANSPORT_SAMPLE_ADDRESS_IDS ?? "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0);
const palletTypes = ["Peco", "Chep", "Régulière"] as const;
const paper = { width: 612, height: 792 };
const black = rgb(0.08, 0.08, 0.08);
const grey = rgb(0.92, 0.92, 0.92);
const randomFrom = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)];
const truncate = (value: unknown, length: number) => String(value ?? "").slice(0, length);
const drawText = (page: PDFPage, font: PDFFont, text: unknown, x: number, y: number, size = 8, bold?: PDFFont) => page.drawText(String(text ?? ""), { x, y, size, font: bold ?? font, color: black });
const drawBarcode = (page: PDFPage, value: string, x: number, y: number, width: number, height: number) => {
  const bits = [...value].flatMap((character) => Number(character).toString(2).padStart(4, "0").split(""));
  const barWidth = width / (bits.length * 1.5);
  let cursor = x;
  bits.forEach((bit, index) => { const current = barWidth * (bit === "1" ? 1.3 : 0.65); if (index % 2 === 0 || bit === "1") page.drawRectangle({ x: cursor, y, width: current, height, color: black }); cursor += barWidth * 1.5; });
};

const isCabbage = (product: Product) => {
  const searchable = `${product.product_type ?? ""} ${product.full_name}`.toLocaleUpperCase("fr-CA");
  return (searchable.includes("CHOU") || searchable.includes("CABBAGE"))
    && !searchable.includes("CHOU-FLEUR")
    && !searchable.includes("CHOUX-FLEUR")
    && !searchable.includes("BRUXELLES");
};

const distributePallets = (total: number, rowCount: number) => {
  const base = Math.floor(total / rowCount);
  const remainder = total % rowCount;
  return Array.from({ length: rowCount }, (_, rowIndex) => base + (rowIndex < remainder ? 1 : 0));
};

async function generateDocument(index: number, client: ClientAddress, products: Product[], usedTripNumbers: Set<string>, shippingDate: string, logoBytes: Uint8Array, requiredTotalPallets?: number) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([paper.width, paper.height]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await pdf.embedPng(logoBytes);
  let tripNumber: string;
  do tripNumber = String(11500 + Math.floor(Math.random() * 500));
  while (usedTripNumbers.has(tripNumber));
  usedTripNumbers.add(tripNumber);
  const po = String(2000000000 + Math.floor(Math.random() * 7999999999));
  const rowCount = 4 + (index % 3);
  const orderPalletType = randomFrom([...palletTypes]);
  const palletAmounts = requiredTotalPallets === undefined
    ? Array.from({ length: rowCount }, () => 1 + Math.floor(Math.random() * 9))
    : distributePallets(requiredTotalPallets, rowCount);
  const rows = products.slice(0, rowCount).map((product, rowIndex) => {
    const pallets = palletAmounts[rowIndex];
    const perPallet = product.qty_per_pallet;
    const quantity = pallets * perPallet;
    const unitWeight = Number(product.weight) || 0;
    return { ...product, pallets, perPallet, quantity, unitWeight, lineWeight: quantity * unitWeight, palletType: orderPalletType };
  });
  const totalPallets = rows.reduce((sum, row) => sum + row.pallets, 0);
  const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  const totalWeight = rows.reduce((sum, row) => sum + row.lineWeight, 0);

  page.drawRectangle({ x: 15, y: 15, width: paper.width - 30, height: paper.height - 30, borderColor: rgb(0.2, 0.2, 0.95), borderWidth: 1 });
  const logoDimensions = logo.scaleToFit(180, 63);
  page.drawImage(logo, { x: 27, y: 705, width: logoDimensions.width, height: logoDimensions.height });
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
    drawText(page, regular, row.product_code, columns[0], y, 8);
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
  return { filename, tripNumber, shippingDate, clientId: client.client_id, addressId: client.address_id, client: client.client_name, address: `${client.address}, ${client.city} ${client.postal_code}`, province: client.province, totalPallets, totalQuantity, totalWeight: Math.round(totalWeight), rows: rows.map((row) => ({ finishedProductId: row.id, code: row.product_code, product: row.full_name, productType: row.product_type, quantityPerPallet: row.qty_per_pallet, quantityToLoad: `${row.pallets}x${row.perPallet}`, quantity: row.quantity, pallets: row.pallets, palletType: row.palletType, unitWeight: row.unitWeight })) };
}

async function main() {
  await fs.mkdir(outputDirectory, { recursive: true });
  let existingManifest: ManifestEntry[] = [];
  try { existingManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  const logoBytes = await fs.readFile(logoPath);
  const addressIds = requestedAddressIds.length ? requestedAddressIds : null;
  const clients = await pool.query<ClientAddress>(`SELECT c.id AS client_id, a.id AS address_id, c.name AS client_name, c.client_number, a.site_number, a.address, a.city, a.postal_code, a.province, a.country FROM sales.clients c JOIN sales.clients_addresses a ON a.client_id = c.id WHERE a.address IS NOT NULL AND a.city IS NOT NULL AND a.postal_code IS NOT NULL AND upper(trim(a.province)) IN ('QC', 'QUEBEC', 'QUÉBEC') AND ($2::int[] IS NULL OR a.id = ANY($2::int[])) ORDER BY CASE WHEN $2::int[] IS NULL THEN random() ELSE array_position($2::int[], a.id)::double precision END LIMIT $1`, [samplesToGenerate, addressIds]);
  const products = await pool.query<Product>(`SELECT id, full_name, product_code, product_type, weight, qty_per_pallet FROM public.finished_product WHERE is_active = true AND product_code IS NOT NULL AND weight IS NOT NULL AND weight > 0 AND qty_per_pallet IS NOT NULL AND qty_per_pallet > 0 ORDER BY random() LIMIT 60`);
  const cabbageProducts = await pool.query<Product>(`SELECT id, full_name, product_code, product_type, weight, qty_per_pallet FROM public.finished_product WHERE is_active = true AND product_code IS NOT NULL AND weight IS NOT NULL AND weight > 0 AND qty_per_pallet IS NOT NULL AND qty_per_pallet > 0 AND (upper(coalesce(product_type, '')) IN ('CHOU PLAT', 'CHOU ROUGE', 'CHOU VERT', 'CHOU DE SAVOIE') OR upper(full_name) LIKE '%CABBAGE%') ORDER BY random() LIMIT 20`);
  if (clients.rows.length < samplesToGenerate || products.rows.length < 10 || cabbageProducts.rows.length === 0) throw new Error("Not enough Quebec clients, addresses, cabbage products, or positive-weight products to generate samples.");
  const shippingDate = process.env.TRANSPORT_SAMPLE_DATE ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  const usedTripNumbers = new Set(existingManifest.map((entry) => entry.tripNumber));
  const generated: ManifestEntry[] = [];
  for (let sampleIndex = 0; sampleIndex < samplesToGenerate; sampleIndex++) {
    const documentIndex = existingManifest.length + sampleIndex;
    const productOffset = sampleIndex * 5;
    let orderedProducts = [...products.rows.slice(productOffset), ...products.rows.slice(0, productOffset)];
    const rowCount = 4 + (documentIndex % 3);
    const requiredTotalPallets = lowPalletBatch ? rowCount + (sampleIndex % 2) : sampleIndex === 0 ? 27 : undefined;
    if (!lowPalletBatch && requiredTotalPallets !== undefined) {
      const cabbage = randomFrom(cabbageProducts.rows);
      orderedProducts = [cabbage, ...orderedProducts.filter((product) => product.id !== cabbage.id)];
    }
    generated.push(await generateDocument(documentIndex, clients.rows[sampleIndex], orderedProducts, usedTripNumbers, shippingDate, logoBytes, requiredTotalPallets));
  }
  const validProvince = (province: string | null) => ["QC", "QUEBEC", "QUÉBEC"].includes((province ?? "").trim().toLocaleUpperCase("fr-CA"));
  const batchIsValid = generated.every((entry) => validProvince(entry.province) && entry.rows.length > 0 && new Set(entry.rows.map((row) => row.palletType)).size === 1 && entry.rows.every((row) => palletTypes.includes(row.palletType)))
    && (lowPalletBatch
      ? generated.every((entry) => entry.totalPallets <= 7)
      : generated.some((entry) => entry.totalPallets === 27 && entry.rows.some((row) => isCabbage({ id: row.finishedProductId, full_name: row.product, product_code: row.code, product_type: row.productType, weight: row.unitWeight, qty_per_pallet: row.quantityPerPallet }))));
  if (!batchIsValid) throw new Error("Generated batch failed Quebec, pallet type, low-pallet, or 27-pallet cabbage validation.");
  const manifest = [...existingManifest, ...generated];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Generated ${generated.length} new documents (${manifest.length} total) in ${outputDirectory}`);
  await pool.end();
}

void main().catch(async (error) => { console.error(error); await pool.end(); process.exitCode = 1; });
