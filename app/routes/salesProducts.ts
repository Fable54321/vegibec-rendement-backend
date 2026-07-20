import { randomUUID } from "crypto";
import { Router } from "express";
import multer from "multer";
import { pool } from "../db";
import { getSignedUrlForKey, uploadBufferToS3 } from "../services/s3.services";

const router = Router();
const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, callback) => callback(null, allowedTypes.has(file.mimetype)),
});

router.get("/clients/:clientId/products", async (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!Number.isSafeInteger(clientId) || clientId <= 0) return res.status(400).json({ error: "Invalid client id" });

  try {
    const clientResult = await pool.query("SELECT id, name FROM sales.clients WHERE id = $1", [clientId]);
    if (clientResult.rowCount === 0) return res.status(404).json({ error: "Client not found" });
    const productsResult = await pool.query(`
      SELECT id, client_id, name, display_order FROM sales.products
      WHERE client_id = $1 AND is_active = TRUE ORDER BY display_order, name, id
    `, [clientId]);
    return res.status(200).json({ client: clientResult.rows[0], products: productsResult.rows });
  } catch (error) {
    console.error("Error fetching products for client:", error);
    return res.status(500).json({ error: "Failed to fetch client products" });
  }
});

router.get("/clients/:clientId/rfq-cells", async (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!Number.isSafeInteger(clientId) || clientId <= 0) return res.status(400).json({ error: "Invalid client id" });
  try {
    const result = await pool.query(`
      SELECT c.id, c.client_id, c.product_id, c.week_start::text, c.location_code, c.status,
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', p.id, 'quantity', p.quantity, 'price', p.price))
          FILTER (WHERE p.id IS NOT NULL), '[]') AS prices,
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', a.id, 'file_name', a.file_name,
          'content_type', a.content_type)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
      FROM sales.rfq_cells c
      LEFT JOIN sales.rfq_prices p ON p.cell_id = c.id
      LEFT JOIN sales.rfq_attachments a ON a.cell_id = c.id
      WHERE c.client_id = $1
      GROUP BY c.id ORDER BY c.week_start, c.product_id, c.location_code
    `, [clientId]);
    return res.json({ cells: result.rows });
  } catch (error) {
    console.error("Error fetching RFQ cells:", error);
    return res.status(500).json({ error: "Failed to fetch RFQ cells" });
  }
});

router.put("/rfq-cells", upload.array("files", 5), async (req, res) => {
  const clientId = Number(req.body.clientId);
  const productId = Number(req.body.productId);
  const { weekStart, locationCode, status } = req.body;
  let prices: Array<{ quantity: number; price: number }>;
  try { prices = JSON.parse(req.body.prices || "[]"); } catch { return res.status(400).json({ error: "Invalid prices" }); }
  if (!Number.isSafeInteger(clientId) || !Number.isSafeInteger(productId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(weekStart || "") || !/^[A-Z]$/.test(locationCode || "") || !["final", "email"].includes(status) ||
      !Array.isArray(prices) || prices.some((p) => !Number.isFinite(Number(p.quantity)) || Number(p.quantity) <= 0 || !Number.isFinite(Number(p.price)) || Number(p.price) < 0)) {
    return res.status(400).json({ error: "Invalid RFQ cell data" });
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const product = await db.query("SELECT 1 FROM sales.products WHERE id = $1 AND client_id = $2", [productId, clientId]);
    if (!product.rowCount) { await db.query("ROLLBACK"); return res.status(400).json({ error: "Product does not belong to client" }); }
    const cellResult = await db.query(`
      INSERT INTO sales.rfq_cells (client_id, product_id, week_start, location_code, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (client_id, product_id, week_start, location_code)
      DO UPDATE SET status = EXCLUDED.status, updated_at = NOW() RETURNING id
    `, [clientId, productId, weekStart, locationCode, status]);
    const cellId = cellResult.rows[0].id;
    await db.query("DELETE FROM sales.rfq_prices WHERE cell_id = $1", [cellId]);
    for (const item of prices) await db.query(
      "INSERT INTO sales.rfq_prices (cell_id, quantity, price) VALUES ($1, $2, $3)",
      [cellId, Number(item.quantity), Number(item.price)],
    );
    for (const file of (req.files as Express.Multer.File[] | undefined) ?? []) {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `sales/rfq/${cellId}/${randomUUID()}-${safeName}`;
      await uploadBufferToS3({ key, buffer: file.buffer, contentType: file.mimetype });
      await db.query(`INSERT INTO sales.rfq_attachments (cell_id, file_name, content_type, s3_key, size_bytes)
        VALUES ($1, $2, $3, $4, $5)`, [cellId, file.originalname, file.mimetype, key, file.size]);
    }
    await db.query("COMMIT");
    return res.json({ id: cellId });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Error saving RFQ cell:", error);
    return res.status(500).json({ error: "Failed to save RFQ cell" });
  } finally { db.release(); }
});

router.get("/rfq-attachments/:attachmentId", async (req, res) => {
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isSafeInteger(attachmentId)) return res.status(400).json({ error: "Invalid attachment id" });
  try {
    const result = await pool.query("SELECT file_name, content_type, s3_key FROM sales.rfq_attachments WHERE id = $1", [attachmentId]);
    if (!result.rowCount) return res.status(404).json({ error: "Attachment not found" });
    const file = result.rows[0];
    const url = await getSignedUrlForKey(file.s3_key, {
      responseContentDisposition: `inline; filename="${String(file.file_name).replace(/["\\]/g, "_")}"`,
      responseContentType: file.content_type,
    });
    return res.json({ url });
  } catch (error) {
    console.error("Error opening RFQ attachment:", error);
    return res.status(500).json({ error: "Failed to open attachment" });
  }
});

export default router;
