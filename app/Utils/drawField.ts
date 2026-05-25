import { rgb } from "pdf-lib";

type PdfPage = any;
type PDFFont = any;

type GridOptions = {
  step?: number;
  labelSize?: number;
  showSubGrid?: boolean;
  subStep?: number;
};

export function drawCoordinateGrid(
  page: PdfPage,
  {
    step = 50,
    labelSize = 8,
    showSubGrid = true,
    subStep = 10,
  }: GridOptions = {}
) {
  const width = page.getWidth();
  const height = page.getHeight();

  // Sub-grid
  if (showSubGrid) {
    for (let x = 0; x <= width; x += subStep) {
      page.drawLine({
        start: { x, y: 0 },
        end: { x, y: height },
        thickness: 0.25,
        opacity: 0.2,
      });
    }

    for (let y = 0; y <= height; y += subStep) {
      page.drawLine({
        start: { x: 0, y },
        end: { x: width, y },
        thickness: 0.25,
        opacity: 0.2,
      });
    }
  }

  // Main grid
  for (let x = 0; x <= width; x += step) {
    page.drawLine({
      start: { x, y: 0 },
      end: { x, y: height },
      thickness: 0.7,
      opacity: 0.5,
    });

    page.drawText(`${x}`, {
      x: Math.min(x + 2, width - 20),
      y: 2,
      size: labelSize,
    });
  }

  for (let y = 0; y <= height; y += step) {
    page.drawLine({
      start: { x: 0, y },
      end: { x: width, y },
      thickness: 0.7,
      opacity: 0.5,
    });

    page.drawText(`${y}`, {
      x: 2,
      y: Math.min(y + 2, height - 10),
      size: labelSize,
    });
  }

  // Origin marker
  page.drawText("(0,0)", {
    x: 5,
    y: 15,
    size: labelSize,
  });

  // Top-left info
  page.drawText(`Page: ${Math.round(width)} x ${Math.round(height)}`, {
    x: 5,
    y: height - 12,
    size: labelSize,
  });
}

type DrawFieldOptions = {
  x: number;
  y: number;
  value: string;
  label?: string;
  width?: number;
  height?: number;
  font?: PDFFont;
  size?: number;
  debug?: boolean;
};

export function drawField(
  page: PdfPage,
  {
    x,
    y,
    value,
    label = "field",
    width = 150,
    height = 18,
    font,
    size = 10,
    debug = true,
  }: DrawFieldOptions
) {
  if (debug) {
    // Field boundary
    page.drawRectangle({
      x,
      y,
      width,
      height,
      color: rgb(1, 1, 1),
      opacity: 0,
      borderColor: rgb(1, 0, 0),
      borderWidth: 0.8,
      borderOpacity: 0.8,
    });

    // Crosshair at anchor point
    page.drawLine({
      start: { x: x - 5, y },
      end: { x: x + 5, y },
      thickness: 0.8,
    });

    page.drawLine({
      start: { x, y: y - 5 },
      end: { x, y: y + 5 },
      thickness: 0.8,
    });

    // Label + coordinates
    page.drawText(`${label} (${x}, ${y})`, {
      x,
      y: y + height + 3,
      size: 8,
    });
  }

  page.drawText(value, {
    x: x + 2,
    y: y + 4,
    size,
    font,
  });
}
