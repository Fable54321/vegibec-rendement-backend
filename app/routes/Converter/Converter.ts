import express from "express";
import multer from "multer";
import path from "path";
import * as XLSX from "xlsx";
import { pool } from "../../db";
import { requireAppRole } from "../../middleware/auth";

const router = express.Router();

const IMPORT_SCHEMA = "test";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});
const SUPPORTED_SPREADSHEET_EXTENSIONS = new Set([
  ".xlsx",
  ".xls",
  ".xlsm",
  ".xlsb",
]);

const uploadSpreadsheet = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  upload.single("file")(req, res, (err) => {
    if (!err) {
      return next();
    }

    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "Excel file is too large. Maximum size is 10 MB.",
      });
    }

    console.error("Error uploading spreadsheet:", err);
    return res.status(400).json({ error: "Failed to upload Excel file" });
  });
};

const isSupportedSpreadsheetFile = (file: Express.Multer.File) => {
  const extension = path.extname(file.originalname).toLowerCase();
  return SUPPORTED_SPREADSHEET_EXTENSIONS.has(extension);
};

const extractColumnsFromSheet = (sheet: XLSX.WorkSheet) => {
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    blankrows: false,
    defval: "",
  }) as unknown[][];

  const headerRow = rows.find(
    (row) =>
      Array.isArray(row) &&
      row.some((cell) => String(cell ?? "").trim().length > 0),
  );

  if (!headerRow) {
    return [];
  }

  return headerRow
    .map((cell) => String(cell ?? "").trim())
    .filter((columnName) => columnName.length > 0);
};

router.get("/import/tables", requireAppRole("convert", ["admin"]), async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `,
      [IMPORT_SCHEMA],
    );

    const tables = result.rows.map((row) => row.table_name);

    res.json(tables);
  } catch (err) {
    console.error("Error fetching tables:", err);
    res.status(500).json({ error: "Failed to fetch tables" });
  }
});

router.get(
  "/import/columns",
  requireAppRole("convert", ["admin"]),
  async (req, res) => {
    const tableName = (req.query.tableName as string | undefined)?.trim();

    if (!tableName) {
      return res.status(400).json({ error: "Missing tableName query parameter" });
    }

    try {
      const result = await pool.query(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = $2
          ORDER BY ordinal_position
        `,
        [IMPORT_SCHEMA, tableName],
      );

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: `No columns found for table "${tableName}"` });
      }

      const columns = result.rows.map((row) => row.column_name);

      res.json(columns);
    } catch (err) {
      console.error("Error fetching columns:", err);
      res.status(500).json({ error: "Failed to fetch columns" });
    }
  },
);

router.post(
  "/import/excel-columns",
  requireAppRole("convert", ["admin"]),
  uploadSpreadsheet,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Missing Excel file" });
    }

    if (!isSupportedSpreadsheetFile(req.file)) {
      return res.status(400).json({
        error: "Unsupported file type. Accepted extensions: .xlsx, .xls, .xlsm, .xlsb",
      });
    }

    const requestedSheetName = (req.query.sheetName as string | undefined)?.trim();

    try {
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });

      if (workbook.SheetNames.length === 0) {
        return res.status(400).json({ error: "The Excel file does not contain any sheets" });
      }

      const sheetName = requestedSheetName || workbook.SheetNames[0];

      if (!workbook.SheetNames.includes(sheetName)) {
        return res.status(404).json({
          error: `Sheet "${sheetName}" was not found in the Excel file`,
          availableSheets: workbook.SheetNames,
        });
      }

      const selectedSheet = workbook.Sheets[sheetName];
      const columns = extractColumnsFromSheet(selectedSheet);

      if (columns.length === 0) {
        return res.status(400).json({
          error: "No header row could be detected in the selected sheet",
        });
      }

      return res.json({
        fileName: req.file.originalname,
        sheetName,
        availableSheets: workbook.SheetNames,
        columns,
      });
    } catch (err) {
      console.error("Error reading Excel file:", err);
      return res.status(500).json({ error: "Failed to read Excel file" });
    }
  },
);


export default router;
