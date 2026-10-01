import fs from "fs/promises";
import path from "path";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

export type DeliverySlipOrderItem = {
  id: number;
  product_name: string;
  product_code: string | null;
  quantity_ordered: string | number;
  actual_pallets: string | number | null;
  planned_pallets: string | number | null;
  pallet_type: string | null;
  origin: string | null;
};

export type DeliverySlipOrder = {
  id: number;
  order_reference: string;
  client_name: string;
  client_number: string | null;
  shipping_address: unknown;
  sold_by: string | null;
  seller_name: string | null;
  customer_po: string | null;
  ordered_date: string | Date | null;
  loaded_date: string | Date | null;
  shipped_date: string | Date | null;
  carrier: string | null;
  items: DeliverySlipOrderItem[];
};

type Address = { line1: string; line2: string; line3: string };

const PAPER = { width: 595.28, height: 841.89 };
const BLACK = rgb(0.05, 0.05, 0.05);
const BLUE = rgb(0.05, 0.12, 0.95);
const PALE_YELLOW = rgb(1, 0.98, 0.55);
const ITEMS_PER_PAGE = 10;
const numberFormatter = new Intl.NumberFormat("fr-CA", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const printable = (value: unknown) =>
  String(value ?? "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "");

const safeNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const truncate = (value: unknown, length: number) => {
  const text = printable(value);
  return text.length > length
    ? `${text.slice(0, Math.max(0, length - 3))}...`
    : text;
};

const formatDate = (value: string | Date | null) => {
  if (!value) return "";
  if (typeof value === "string") {
    const calendarDate = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (calendarDate) {
      const [year, month, day] = calendarDate.split("-");
      return `${day}/${month}/${year}`;
    }
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fr-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Toronto",
  }).format(date);
};

const formatAddress = (value: unknown): Address => {
  if (!value) return { line1: "", line2: "", line3: "" };
  let address = value;
  if (typeof value === "string") {
    try {
      address = JSON.parse(value);
    } catch {
      const lines = value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return {
        line1: lines[0] ?? "",
        line2: lines[1] ?? "",
        line3: lines.slice(2).join(", "),
      };
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

const drawText = (
  page: PDFPage,
  font: PDFFont,
  value: unknown,
  x: number,
  y: number,
  size = 7,
) => page.drawText(printable(value), { x, y, size, font, color: BLACK });

const drawCenteredText = (
  page: PDFPage,
  font: PDFFont,
  value: unknown,
  centerX: number,
  y: number,
  size = 7,
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

const drawRightText = (
  page: PDFPage,
  font: PDFFont,
  value: unknown,
  rightX: number,
  y: number,
  size = 7,
) => {
  const text = printable(value);
  drawText(
    page,
    font,
    text,
    rightX - font.widthOfTextAtSize(text, size),
    y,
    size,
  );
};

const line = (
  page: PDFPage,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width = 0.65,
) =>
  page.drawLine({
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    thickness: width,
    color: BLACK,
  });

const box = (
  page: PDFPage,
  x: number,
  y: number,
  width: number,
  height: number,
  borderWidth = 0.65,
) =>
  page.drawRectangle({ x, y, width, height, borderColor: BLACK, borderWidth });

const fitText = (
  page: PDFPage,
  font: PDFFont,
  value: unknown,
  x: number,
  y: number,
  maxWidth: number,
  preferredSize = 7,
  minimumSize = 5,
) => {
  const text = printable(value);
  if (!text) return;
  const naturalWidth = font.widthOfTextAtSize(text, preferredSize);
  const size = Math.max(
    minimumSize,
    Math.min(preferredSize, (preferredSize * maxWidth) / naturalWidth),
  );
  drawText(page, font, text, x, y, size);
};

// Code 39 is deliberately used here so the order barcode is readable by ordinary scanners.
const CODE_39: Record<string, string> = {
  "0": "nnnwwnwnn",
  "1": "wnnwnnnnw",
  "2": "nnwwnnnnw",
  "3": "wnwwnnnnn",
  "4": "nnnwwnnnw",
  "5": "wnnwwnnnn",
  "6": "nnwwwnnnn",
  "7": "nnnwnnwnw",
  "8": "wnnwnnwnn",
  "9": "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  "*": "nwnnwnwnn",
};

const drawCode39 = (
  page: PDFPage,
  value: unknown,
  x: number,
  y: number,
  width: number,
  height: number,
) => {
  const clean = printable(value)
    .toUpperCase()
    .replace(/[^0-9A-Z. -]/g, "-");
  const encoded = `*${clean}*`;
  const units = [...encoded].reduce((total, character) => {
    const pattern = CODE_39[character] ?? CODE_39["-"];
    return (
      total +
      [...pattern].reduce((sum, part) => sum + (part === "w" ? 3 : 1), 0) +
      1
    );
  }, 0);
  const unit = width / units;
  let cursor = x;
  for (const character of encoded) {
    const pattern = CODE_39[character] ?? CODE_39["-"];
    [...pattern].forEach((part, index) => {
      const elementWidth = (part === "w" ? 3 : 1) * unit;
      if (index % 2 === 0) {
        page.drawRectangle({
          x: cursor,
          y,
          width: elementWidth,
          height,
          color: BLACK,
        });
      }
      cursor += elementWidth;
    });
    cursor += unit;
  }
};

const itemPallets = (item: DeliverySlipOrderItem) => {
  const actual = safeNumber(item.actual_pallets);
  return actual > 0 ? actual : safeNumber(item.planned_pallets);
};

const drawLabelAndLine = (
  page: PDFPage,
  font: PDFFont,
  label: string,
  x: number,
  y: number,
  lineEnd: number,
) => {
  drawText(page, font, label, x, y, 6.5);
  const labelWidth = font.widthOfTextAtSize(label, 6.5);
  line(page, x + labelWidth + 4, y - 1, lineEnd, y - 1, 0.6);
};

export async function createDeliverySlipPdf(order: DeliverySlipOrder) {
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
  const clientLabel = [order.client_number, order.client_name]
    .filter(Boolean)
    .join(" - ");
  const orderLabel = printable(order.order_reference || order.id);

  chunks.forEach((items, pageIndex) => {
    const page = pdf.addPage([PAPER.width, PAPER.height]);
    page.drawRectangle({
      x: 18,
      y: 14,
      width: PAPER.width - 36,
      height: PAPER.height - 28,
      borderColor: BLUE,
      borderWidth: 0.9,
    });

    page.drawImage(logo, { x: 22, y: 766, width: 145, height: 46 });
    box(page, 225, 793, 145, 36, 0.8);
    drawCenteredText(page, regular, "Bon de Livraison", 297.5, 815, 12);
    drawCenteredText(page, regular, "Bill of lading", 297.5, 801, 10);

    drawCenteredText(page, bold, "Vegibec", 298, 780, 6.5);
    drawCenteredText(page, regular, "171 Rang Ste-Sophie", 298, 770, 5.5);
    drawCenteredText(
      page,
      regular,
      "OKA, Qu\u00e9bec, Canada, J0N 1E0",
      298,
      761,
      5.5,
    );
    drawCenteredText(page, regular, "(450) 596-0568", 298, 752, 5.5);

    box(page, 458, 737, 115, 92, 0.8);
    line(page, 458, 806, 573, 806);
    line(page, 458, 783, 573, 783);
    line(page, 458, 760, 573, 760);
    line(page, 527, 806, 527, 829);
    drawCenteredText(page, regular, "NO FACTURE", 492.5, 819, 4.6);
    drawCenteredText(page, regular, "INVOICE", 492.5, 812, 4.6);
    drawCenteredText(page, regular, "PAGE", 550, 814, 4.6);
    drawCenteredText(
      page,
      regular,
      `${pageIndex + 1} / ${chunks.length}`,
      550,
      790,
      6.5,
    );
    drawCenteredText(
      page,
      regular,
      "CHARG\u00c9E / LOADED DATE",
      515.5,
      776,
      4.8,
    );
    drawCenteredText(
      page,
      regular,
      formatDate(order.loaded_date),
      515.5,
      766,
      6.5,
    );
    drawCenteredText(page, regular, "NO COMMANDE / ORDER #", 515.5, 755, 4.8);
    drawCenteredText(page, regular, truncate(orderLabel, 24), 515.5, 746, 6);
    drawCode39(page, orderLabel, 481, 738, 69, 6);

    drawText(page, bold, "Vendu / Sold to", 24, 731, 7);
    drawText(page, regular, truncate(clientLabel, 45), 24, 718, 6.5);
    drawText(page, regular, truncate(address.line1, 48), 24, 707, 6.5);
    drawText(page, regular, truncate(address.line2, 48), 24, 696, 6.5);
    drawText(page, regular, truncate(address.line3, 48), 24, 685, 6.5);

    drawText(page, bold, "Exp\u00e9di\u00e9 / Shipped to", 244, 731, 7);
    drawText(page, regular, truncate(clientLabel, 39), 244, 718, 6.5);
    drawText(page, regular, truncate(address.line1, 42), 244, 707, 6.5);
    drawText(page, regular, truncate(address.line2, 42), 244, 696, 6.5);
    drawText(page, regular, truncate(address.line3, 42), 244, 685, 6.5);
    drawText(page, bold, "IRS:", 24, 662, 6.5);
    drawText(page, bold, "IRS:", 244, 662, 6.5);
    drawText(page, bold, "COMMENTAIRES / COMMENTS:", 24, 646, 6.5);

    const metaTop = 638;
    const metaBottom = 600;
    box(page, 22, metaBottom, 551, metaTop - metaBottom, 0.7);
    line(page, 22, 619, 573, 619);
    const metaColumns = [77, 132, 196, 252, 352, 432, 508];
    metaColumns.forEach((x) => line(page, x, metaBottom, x, metaTop));
    const headings = [
      ["ENVOY\u00c9E", "SHIPPED"],
      ["LIVR\u00c9E", "DELIVERY DATE"],
      ["VENDEUR", "SALESMAN"],
      ["NO CLIENT", "CUST NO"],
      ["VENDEUR", "SALESMAN"],
      ["PO #", ""],
      ["TRANSPORT", ""],
      ["TERMES", "TERMS"],
    ];
    const centers = [49.5, 104.5, 164, 224, 302, 392, 470, 540.5];
    headings.forEach(([first, second], index) => {
      drawCenteredText(page, regular, first, centers[index], 631, 4.5);
      if (second)
        drawCenteredText(page, regular, second, centers[index], 625, 4.2);
    });
    const metaValues = [
      formatDate(order.shipped_date ?? order.ordered_date),
      "",
      truncate(order.sold_by ?? "", 12),
      truncate(order.client_number ?? "", 12),
      truncate(order.seller_name ?? "", 19),
      truncate(order.customer_po ?? "", 16),
      truncate(order.carrier ?? "", 14),
      "",
    ];
    metaValues.forEach((value, index) =>
      drawCenteredText(page, regular, value, centers[index], 607, 5.7),
    );

    const tableTop = 596;
    const tableBottom = 281;
    const tableColumns = [80, 143, 181, 439];
    box(page, 22, tableBottom, 551, tableTop - tableBottom, 0.7);
    line(page, 22, 577, 573, 577);
    tableColumns.forEach((x) => line(page, x, tableBottom, x, tableTop));
    drawCenteredText(page, regular, "QUANTIT\u00c9", 51, 588, 4.8);
    drawCenteredText(page, regular, "QUANTITY", 51, 582, 4.3);
    drawCenteredText(page, regular, "PRODUIT", 111.5, 588, 4.8);
    drawCenteredText(page, regular, "PRODUCT", 111.5, 582, 4.3);
    drawCenteredText(page, regular, "NO", 162, 588, 4.8);
    drawCenteredText(page, regular, "PALETTE", 162, 582, 4.3);
    drawCenteredText(page, regular, "DESCRIPTION", 310, 584, 4.8);
    drawCenteredText(page, regular, "UM", 506, 584, 4.8);

    let rowY = 562;
    items.forEach((item) => {
      drawRightText(
        page,
        regular,
        numberFormatter.format(safeNumber(item.quantity_ordered)),
        72,
        rowY,
        6.5,
      );
      drawCenteredText(
        page,
        regular,
        truncate(item.product_code ?? "", 13),
        111.5,
        rowY,
        6.2,
      );
      drawCenteredText(
        page,
        regular,
        numberFormatter.format(itemPallets(item)),
        162,
        rowY,
        6.2,
      );
      const description = [item.product_name, item.origin]
        .filter(Boolean)
        .join(" - ");
      fitText(page, regular, description, 186, rowY, 247, 6.2, 4.8);
      rowY -= 27;
    });

    box(page, 22, 250, 551, 25, 0.7);

    // Everything below this point is intentionally blank for handwritten completion.
    box(page, 27, 193, 461, 52, 0.9);
    drawLabelAndLine(page, bold, "Carrier #:", 32, 226, 211);
    drawLabelAndLine(page, bold, "Trailer #:", 259, 226, 423);
    drawLabelAndLine(page, bold, "Recorder #:", 32, 204, 211);
    drawLabelAndLine(page, bold, "Truck #:", 259, 204, 423);

    page.drawRectangle({
      x: 30,
      y: 172,
      width: 276,
      height: 14,
      color: PALE_YELLOW,
    });
    drawText(
      page,
      regular,
      "Temp\u00e9rature continue \u00e0 / Continuous temperature at:",
      45,
      176,
      6,
    );
    box(page, 308, 170, 43, 18, 0.7);
    drawText(page, regular, "Initiales", 356, 179, 5);
    drawText(page, regular, "Initials", 356, 172, 5);
    drawText(
      page,
      bold,
      "All claims of whatever nature against this bill must be made within 48 hours after receipt of goods.",
      30,
      154,
      5.5,
    );

    drawLabelAndLine(page, regular, "Transporteur / Carrier:", 27, 85, 332);
    drawLabelAndLine(page, regular, "Livraison / Delivery:", 27, 62, 332);
    drawLabelAndLine(page, regular, "Palettes in:", 400, 85, 456);
    drawLabelAndLine(page, regular, "Palettes out:", 400, 62, 456);

    const checks = [
      ["Rej", "PE"],
      ["CF", "CH"],
      ["Reg", "PE"],
      ["CF", "CH"],
    ];
    checks.forEach(([left, right], index) => {
      const y = 91 - index * 13;
      box(page, 486, y, 11, 11, 0.6);
      drawText(page, regular, left, 501, y + 3, 5.5);
      box(page, 532, y, 11, 11, 0.6);
      drawText(page, regular, right, 547, y + 3, 5.5);
    });
  });

  return Buffer.from(await pdf.save());
}
