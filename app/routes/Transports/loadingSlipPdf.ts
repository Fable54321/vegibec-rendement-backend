import fs from "fs/promises";
import path from "path";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

export type LoadingSlipOrderItem = {
  id: number;
  product_name: string;
  product_code: string | null;
  quantity_ordered: string | number;
  quantity_per_pallet: string | number | null;
  actual_pallets: string | number | null;
  planned_pallets: string | number | null;
  pallet_type: string | null;
  product_weight: string | number | null;
};

export type LoadingSlipOrder = {
  id: number;
  order_reference: string;
  client_name: string;
  client_number: string | null;
  shipping_address: unknown;
  sold_by: string | null;
  seller_name: string | null;
  trip_number: string | number | null;
  customer_po: string | null;
  loaded_date: string | Date | null;
  shipped_date: string | Date | null;
  carrier: string | null;
  transport_temperature: string | number | null;
  items: LoadingSlipOrderItem[];
};

type Address = { line1: string; line2: string; line3: string };

const PAPER = { width: 612, height: 792 };
const BLACK = rgb(0.08, 0.08, 0.08);
const BLUE = rgb(0.2, 0.2, 0.95);
const GREY = rgb(0.92, 0.92, 0.92);
const ITEMS_PER_PAGE = 8;
const numberFormatter = new Intl.NumberFormat("fr-CA", {
  maximumFractionDigits: 2,
});

const safeNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const printable = (value: unknown) =>
  String(value ?? "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "");

const truncate = (value: unknown, length: number) => {
  const text = printable(value);
  return text.length > length
    ? `${text.slice(0, Math.max(0, length - 3))}...`
    : text;
};

const drawText = (
  page: PDFPage,
  font: PDFFont,
  value: unknown,
  x: number,
  y: number,
  size = 8,
) => {
  page.drawText(printable(value), { x, y, size, font, color: BLACK });
};

const drawCenteredText = (
  page: PDFPage,
  font: PDFFont,
  value: unknown,
  centerX: number,
  y: number,
  size = 8,
) => {
  const text = printable(value);
  drawText(
    page,
    font,
    text,
    centerX - font.widthOfTextAtSize(text, size) / 2,
    y,
    size,
  );
};

const formatDate = (value: string | Date | null) => {
  if (!value) return "";
  if (typeof value === "string") {
    const calendarDate = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (calendarDate) return calendarDate;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

const formatAddress = (value: unknown): Address => {
  if (!value) return { line1: "", line2: "", line3: "" };
  let address = value;
  if (typeof value === "string") {
    try {
      address = JSON.parse(value);
    } catch {
      return { line1: value, line2: "", line3: "" };
    }
  }
  if (typeof address !== "object" || address === null) {
    return { line1: String(address), line2: "", line3: "" };
  }
  const snapshot = address as Record<string, unknown>;
  if (snapshot.manual_address) {
    const lines = String(snapshot.manual_address)
      .split(/\r?\n|,/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      line1: lines[0] ?? "",
      line2: lines.slice(1, -1).join(", "),
      line3: lines.length > 1 ? (lines.at(-1) ?? "") : "",
    };
  }
  return {
    line1: String(snapshot.address ?? ""),
    line2: [snapshot.city, snapshot.province].filter(Boolean).join(", "),
    line3: [snapshot.postal_code, snapshot.country].filter(Boolean).join(" "),
  };
};

const drawBarcode = (
  page: PDFPage,
  value: string,
  x: number,
  y: number,
  width: number,
  height: number,
) => {
  const bits = [...value].flatMap((character) =>
    character.charCodeAt(0).toString(2).padStart(8, "0").split(""),
  );
  if (!bits.length) return;
  const barWidth = width / bits.length;
  bits.forEach((bit, index) => {
    if (bit === "1") {
      page.drawRectangle({
        x: x + index * barWidth,
        y,
        width: Math.max(0.45, barWidth),
        height,
        color: BLACK,
      });
    }
  });
};

const palletsForItem = (item: LoadingSlipOrderItem) => {
  const actual = safeNumber(item.actual_pallets);
  if (actual > 0) return actual;
  const planned = safeNumber(item.planned_pallets);
  if (planned > 0) return planned;
  const perPallet = safeNumber(item.quantity_per_pallet);
  return perPallet > 0
    ? Math.ceil(safeNumber(item.quantity_ordered) / perPallet)
    : 0;
};

const quantityToLoad = (item: LoadingSlipOrderItem) => {
  const pallets = palletsForItem(item);
  const perPallet = safeNumber(item.quantity_per_pallet);
  return pallets > 0 && perPallet > 0
    ? `${numberFormatter.format(pallets)}x${numberFormatter.format(perPallet)}`
    : numberFormatter.format(safeNumber(item.quantity_ordered));
};

export async function createLoadingSlipPdf(order: LoadingSlipOrder) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logoPath = path.resolve(__dirname, "../../../app/assets/vegibec.png");
  const logo = await pdf.embedPng(await fs.readFile(logoPath));
  const address = formatAddress(order.shipping_address);
  const chunks = Array.from(
    { length: Math.max(1, Math.ceil(order.items.length / ITEMS_PER_PAGE)) },
    (_, index) =>
      order.items.slice(index * ITEMS_PER_PAGE, (index + 1) * ITEMS_PER_PAGE),
  );
  const totalQuantity = order.items.reduce(
    (sum, item) => sum + safeNumber(item.quantity_ordered),
    0,
  );
  const totalPallets = order.items.reduce(
    (sum, item) => sum + palletsForItem(item),
    0,
  );
  const totalWeight = order.items.reduce(
    (sum, item) =>
      sum + safeNumber(item.quantity_ordered) * safeNumber(item.product_weight),
    0,
  );
  const shippingDate = formatDate(order.loaded_date ?? order.shipped_date);
  const tripNumber = printable(order.trip_number || order.order_reference);
  const clientLabel = [order.client_number, order.client_name]
    .filter(Boolean)
    .join(" - ");
  const orderLabel = printable(order.order_reference || order.id);

  chunks.forEach((items, pageIndex) => {
    const page = pdf.addPage([PAPER.width, PAPER.height]);
    page.drawRectangle({
      x: 15,
      y: 15,
      width: PAPER.width - 30,
      height: PAPER.height - 30,
      borderColor: BLUE,
      borderWidth: 1,
    });

    const logoWidth = 164;
    const logoHeight = logoWidth * (logo.height / logo.width);
    page.drawImage(logo, {
      x: 27,
      y: 710,
      width: logoWidth,
      height: logoHeight,
    });
    drawCenteredText(page, bold, "Vegibec", 310, 752, 12);
    drawCenteredText(page, regular, "171 Rang Ste-Sophie", 310, 737, 8);
    drawCenteredText(
      page,
      regular,
      "OKA, Québec, Canada, J0N 1E0",
      310,
      725,
      8,
    );
    drawCenteredText(page, regular, "Téléphone (450) 596-0568", 310, 713, 7);
    drawCenteredText(page, bold, "Chargement voyage", 505, 752, 13);
    drawCenteredText(page, regular, "No Voyage", 505, 733, 12);
    drawCenteredText(page, bold, tripNumber, 505, 709, 16);
    if (chunks.length > 1)
      drawCenteredText(
        page,
        regular,
        `Page ${pageIndex + 1} / ${chunks.length}`,
        505,
        696,
        7,
      );
    page.drawLine({
      start: { x: 25, y: 690 },
      end: { x: 587, y: 690 },
      thickness: 2,
      color: BLACK,
    });

    page.drawRectangle({
      x: 25,
      y: 646,
      width: 562,
      height: 34,
      borderColor: BLACK,
      borderWidth: 1,
    });
    [105, 270, 500].forEach((x) =>
      page.drawLine({
        start: { x, y: 646 },
        end: { x, y: 680 },
        thickness: 1,
        color: BLACK,
      }),
    );
    drawText(page, bold, "Shipping / Chargé", 28, 667, 7);
    drawCenteredText(page, regular, shippingDate, 65, 652, 8);
    drawText(page, bold, "Sold by / Vendeur", 150, 667, 7);
    drawCenteredText(
      page,
      regular,
      order.seller_name ?? order.sold_by ?? "",
      187,
      652,
      8,
    );
    drawText(page, bold, "Carrier / Transporteur", 340, 667, 7);
    drawCenteredText(page, regular, order.carrier ?? "", 385, 652, 8);
    drawText(page, bold, "Truck temp", 530, 667, 7);
    drawCenteredText(
      page,
      regular,
      order.transport_temperature == null
        ? ""
        : `${order.transport_temperature}°`,
      544,
      652,
      8,
    );

    drawText(page, bold, `Sold to :  ${truncate(clientLabel, 38)}`, 25, 625, 8);
    drawText(page, regular, truncate(address.line1, 46), 70, 610, 8);
    drawText(page, regular, truncate(address.line2, 46), 70, 597, 8);
    drawText(page, regular, truncate(address.line3, 46), 70, 584, 8);
    drawText(
      page,
      bold,
      `Shipped to :  ${truncate(clientLabel, 34)}`,
      315,
      625,
      8,
    );
    drawText(page, regular, truncate(address.line1, 38), 366, 610, 8);
    drawText(page, regular, truncate(address.line2, 38), 366, 597, 8);
    drawText(page, regular, truncate(address.line3, 38), 366, 584, 8);
    drawText(page, bold, "Bon Com.:", 478, 560, 9);
    const orderText = truncate(orderLabel, 17);
    const orderTextSize = Math.min(
      8,
      50 / bold.widthOfTextAtSize(orderText, 1),
    );
    drawText(
      page,
      bold,
      orderText,
      575 - bold.widthOfTextAtSize(orderText, orderTextSize),
      559,
      orderTextSize,
    );
    drawBarcode(page, `${order.id}-${orderLabel}`, 480, 513, 95, 34);
    drawText(
      page,
      regular,
      `No client:  ${order.client_number ?? ""}`,
      25,
      560,
      8,
    );
    drawText(page, bold, `PO:  ${order.customer_po ?? ""}`, 155, 560, 8);

    const pageLabel =
      chunks.length > 1 ? `   ${pageIndex + 1} / ${chunks.length}` : "   1";
    drawText(page, bold, `Chargement #:${pageLabel}`, 25, 500, 9);
    drawText(
      page,
      bold,
      `Chargé chez:   ${order.sold_by ?? "Vegibec"}`,
      265,
      500,
      9,
    );
    const columns = [25, 92, 155, 385, 465, 535];
    ["Code", "Lot #", "Item", "Qté à charger", "Qté chargé", "Palette"].forEach(
      (heading, index) => drawText(page, bold, heading, columns[index], 477, 7),
    );

    let y = 455;
    items.forEach((item) => {
      const pallets = palletsForItem(item);
      drawText(
        page,
        regular,
        truncate(item.product_code ?? "", 12),
        columns[0],
        y,
        8,
      );
      drawText(page, regular, "", columns[1], y, 7);
      drawText(
        page,
        regular,
        truncate(item.product_name, 43),
        columns[2],
        y,
        7.5,
      );
      drawText(page, bold, quantityToLoad(item), columns[3], y, 8);
      page.drawRectangle({
        x: columns[4],
        y: y - 4,
        width: 45,
        height: 18,
        borderColor: BLACK,
        borderWidth: 0.8,
      });
      drawText(
        page,
        bold,
        `${numberFormatter.format(pallets)} ${truncate(item.pallet_type ?? "", 10)}`.trim(),
        columns[5],
        y,
        8,
      );
      y -= 32;
    });

    page.drawRectangle({
      x: 25,
      y: y - 2,
      width: 562,
      height: 22,
      color: GREY,
    });
    drawText(page, bold, "Poids total", 28, y + 5, 8);
    drawText(page, bold, numberFormatter.format(totalWeight), 95, y + 5, 8);
    drawText(page, bold, "Total", 270, y + 5, 8);
    drawText(page, bold, numberFormatter.format(totalQuantity), 390, y + 5, 8);
    drawText(page, bold, numberFormatter.format(totalPallets), 520, y + 5, 8);

    drawText(page, bold, "Carrier:", 25, 165, 8);
    page.drawLine({
      start: { x: 95, y: 164 },
      end: { x: 330, y: 164 },
      thickness: 0.8,
      color: BLACK,
    });
    drawText(page, bold, "Quantité total chargé:", 375, 150, 8);
    drawText(page, bold, numberFormatter.format(totalQuantity), 505, 150, 8);
    drawText(page, bold, "Poids total:", 375, 126, 8);
    drawText(page, bold, numberFormatter.format(totalWeight), 505, 126, 8);
    drawText(page, bold, "TOTAL PALETTES:", 375, 102, 9);
    drawText(page, bold, numberFormatter.format(totalPallets), 505, 102, 9);
    drawText(page, bold, "Signature:", 25, 45, 8);
    page.drawLine({
      start: { x: 85, y: 44 },
      end: { x: 330, y: 44 },
      thickness: 0.8,
      color: BLACK,
    });
  });

  return Buffer.from(await pdf.save());
}
