import { randomUUID } from "crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { pool } from "../db";
import { deleteObjectFromS3, getSignedUrlForKey, uploadBufferToS3 } from "../services/s3.services";
import {
  disconnectMicrosoftAccount,
  exchangeMicrosoftCode,
  getMicrosoftAuthorizationUrl,
  getMicrosoftConnectionStatus,
  getOutlookMessage,
  listOutlookMessages,
  saveMicrosoftConnection,
} from "../services/microsoftGraph.services";

const router = Router();
const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "message/rfc822", "application/vnd.ms-outlook",
]);
const emailContentTypesByExtension = {
  ".eml": "message/rfc822",
  ".msg": "application/vnd.ms-outlook",
} as const;
type EmailExtension = keyof typeof emailContentTypesByExtension;

const getEmailExtension = (fileName: string): EmailExtension | undefined => {
  const normalizedName = fileName.toLowerCase();
  return (Object.keys(emailContentTypesByExtension) as EmailExtension[])
    .find((extension) => normalizedName.endsWith(extension));
};

const getStoredContentType = (file: Express.Multer.File) => {
  const emailExtension = getEmailExtension(file.originalname);
  return emailExtension
    ? emailContentTypesByExtension[emailExtension]
    : file.mimetype || "application/octet-stream";
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, callback) => {
    const emailExtension = getEmailExtension(file.originalname);
    const isEmail = emailExtension && (
      file.mimetype === emailContentTypesByExtension[emailExtension] ||
      file.mimetype === "application/octet-stream"
    );
    callback(null, allowedTypes.has(file.mimetype) || Boolean(isEmail));
  },
});

const outlookStateSecret = process.env.JWT_SECRET || "super_secret";
const outlookFrontendUrl = () =>
  (process.env.OUTLOOK_FRONTEND_URL || "https://devis.vegibec-portail.com").replace(/\/+$/, "");

router.get("/outlook/status", async (req, res) => {
  try {
    return res.json(await getMicrosoftConnectionStatus(req.user!.id));
  } catch (error) {
    console.error("Error reading Microsoft connection status:", error);
    return res.status(500).json({ error: "Failed to read Microsoft connection status" });
  }
});

router.get("/outlook/connect", (req, res) => {
  try {
    const state = jwt.sign(
      { userId: req.user!.id, nonce: randomUUID(), purpose: "outlook-connect" },
      outlookStateSecret,
      { expiresIn: "10m" },
    );
    return res.json({ url: getMicrosoftAuthorizationUrl(state) });
  } catch (error) {
    console.error("Error starting Microsoft connection:", error);
    return res.status(500).json({ error: "Microsoft Graph integration is not configured" });
  }
});

router.get("/outlook/callback", async (req, res) => {
  const frontendUrl = outlookFrontendUrl();
  try {
    if (typeof req.query.error === "string") {
      return res.redirect(`${frontendUrl}/rfq?outlook=error`);
    }
    if (typeof req.query.code !== "string" || typeof req.query.state !== "string") {
      return res.redirect(`${frontendUrl}/rfq?outlook=error`);
    }
    const state = jwt.verify(req.query.state, outlookStateSecret) as {
      userId: number;
      purpose: string;
    };
    if (state.purpose !== "outlook-connect" || !Number.isSafeInteger(state.userId)) {
      return res.redirect(`${frontendUrl}/rfq?outlook=error`);
    }
    const connection = await exchangeMicrosoftCode(req.query.code);
    await saveMicrosoftConnection(state.userId, connection);
    return res.redirect(`${frontendUrl}/rfq?outlook=connected`);
  } catch (error) {
    console.error("Microsoft OAuth callback failed:", error);
    return res.redirect(`${frontendUrl}/rfq?outlook=error`);
  }
});

router.delete("/outlook/connection", async (req, res) => {
  try {
    await disconnectMicrosoftAccount(req.user!.id);
    return res.status(204).send();
  } catch (error) {
    console.error("Error disconnecting Microsoft account:", error);
    return res.status(500).json({ error: "Failed to disconnect Microsoft account" });
  }
});

router.get("/outlook/messages", async (req, res) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.slice(0, 200) : "";
    return res.json({ messages: await listOutlookMessages(req.user!.id, search) });
  } catch (error) {
    const status = Number((error as Error & { status?: number }).status) || 500;
    console.error("Error loading Outlook messages:", error);
    return res.status(status).json({
      error: status === 409 ? "Microsoft account is not connected" : "Failed to load Outlook messages",
    });
  }
});

router.get("/outlook-links/:linkId/open", async (req, res) => {
  const linkId = Number(req.params.linkId);
  if (!Number.isSafeInteger(linkId) || linkId <= 0) {
    return res.status(400).json({ error: "Invalid Outlook link id" });
  }
  try {
    const result = await pool.query(
      `SELECT microsoft_message_id FROM sales.rfq_email_links
       WHERE id = $1 AND user_id = $2`,
      [linkId, req.user!.id],
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "Outlook link not found for this user" });
    }
    const message = await getOutlookMessage(req.user!.id, result.rows[0].microsoft_message_id);
    await pool.query(
      "UPDATE sales.rfq_email_links SET web_link = $1 WHERE id = $2",
      [message.webLink, linkId],
    );
    return res.json({ url: message.webLink });
  } catch (error) {
    console.error("Error opening Outlook message:", error);
    return res.status(500).json({ error: "Failed to open Outlook message" });
  }
});

router.delete("/outlook-links/:linkId", async (req, res) => {
  const linkId = Number(req.params.linkId);
  if (!Number.isSafeInteger(linkId) || linkId <= 0) {
    return res.status(400).json({ error: "Invalid Outlook link id" });
  }
  const result = await pool.query(
    "DELETE FROM sales.rfq_email_links WHERE id = $1 AND user_id = $2 RETURNING id",
    [linkId, req.user!.id],
  );
  return result.rowCount ? res.status(204).send() : res.status(404).json({ error: "Outlook link not found" });
});

router.get("/clients/:clientId/products", async (req, res) => {
  const clientId = Number(req.params.clientId);
  const includeInactive = req.query.includeInactive === "true";
  if (!Number.isSafeInteger(clientId) || clientId <= 0) return res.status(400).json({ error: "Invalid client id" });

  try {
    const clientResult = await pool.query("SELECT id, name FROM sales.clients WHERE id = $1", [clientId]);
    if (clientResult.rowCount === 0) return res.status(404).json({ error: "Client not found" });
    const productsResult = await pool.query(`
      SELECT id, client_id, name, display_order, is_active FROM sales.products
      WHERE client_id = $1 AND ($2::boolean OR is_active = TRUE)
      ORDER BY is_active DESC, display_order, name, id
    `, [clientId, includeInactive]);
    return res.status(200).json({ client: clientResult.rows[0], products: productsResult.rows });
  } catch (error) {
    console.error("Error fetching products for client:", error);
    return res.status(500).json({ error: "Failed to fetch client products" });
  }
});

router.post("/clients/:clientId/products", async (req, res) => {
  const clientId = Number(req.params.clientId);
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!Number.isSafeInteger(clientId) || clientId <= 0) {
    return res.status(400).json({ error: "Invalid client id" });
  }
  if (!name || name.length > 150) {
    return res.status(400).json({ error: "Product name must contain between 1 and 150 characters" });
  }

  try {
    const clientResult = await pool.query("SELECT 1 FROM sales.clients WHERE id = $1", [clientId]);
    if (!clientResult.rowCount) return res.status(404).json({ error: "Client not found" });

    const duplicate = await pool.query(
      "SELECT 1 FROM sales.products WHERE client_id = $1 AND LOWER(name) = LOWER($2)",
      [clientId, name],
    );
    if (duplicate.rowCount) {
      return res.status(409).json({ error: "A product with this name already exists for this client" });
    }

    const result = await pool.query(`
      INSERT INTO sales.products (client_id, name, display_order, is_active)
      SELECT $1, $2, COALESCE(MAX(display_order), 0) + 1, TRUE
      FROM sales.products
      WHERE client_id = $1
      RETURNING id, client_id, name, display_order
    `, [clientId, name]);
    return res.status(201).json({ product: result.rows[0] });
  } catch (error) {
    console.error("Error creating product for client:", error);
    return res.status(500).json({ error: "Failed to create client product" });
  }
});

router.patch("/clients/:clientId/products/:productId/deactivate", async (req, res) => {
  const clientId = Number(req.params.clientId);
  const productId = Number(req.params.productId);
  if (!Number.isSafeInteger(clientId) || clientId <= 0 ||
      !Number.isSafeInteger(productId) || productId <= 0) {
    return res.status(400).json({ error: "Invalid client or product id" });
  }

  try {
    const result = await pool.query(`
      UPDATE sales.products
      SET is_active = FALSE
      WHERE id = $1 AND client_id = $2
      RETURNING id
    `, [productId, clientId]);
    if (!result.rowCount) {
      return res.status(404).json({ error: "Product not found for this client" });
    }
    return res.status(200).json({ id: result.rows[0].id, is_active: false });
  } catch (error) {
    console.error("Error deactivating client product:", error);
    return res.status(500).json({ error: "Failed to deactivate client product" });
  }
});

router.patch("/clients/:clientId/products/:productId/activate", async (req, res) => {
  const clientId = Number(req.params.clientId);
  const productId = Number(req.params.productId);
  if (!Number.isSafeInteger(clientId) || clientId <= 0 ||
      !Number.isSafeInteger(productId) || productId <= 0) {
    return res.status(400).json({ error: "Invalid client or product id" });
  }

  try {
    const result = await pool.query(`
      UPDATE sales.products
      SET is_active = TRUE
      WHERE id = $1 AND client_id = $2
      RETURNING id
    `, [productId, clientId]);
    if (!result.rowCount) {
      return res.status(404).json({ error: "Product not found for this client" });
    }
    return res.status(200).json({ id: result.rows[0].id, is_active: true });
  } catch (error) {
    console.error("Error activating client product:", error);
    return res.status(500).json({ error: "Failed to activate client product" });
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
          'content_type', a.content_type)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments,
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
          'id', e.id, 'user_id', e.user_id, 'owner_username', u.username,
          'subject', e.subject, 'sender_name', e.sender_name, 'sender_email', e.sender_email,
          'received_at', e.received_at
        )) FILTER (WHERE e.id IS NOT NULL), '[]') AS email_links
      FROM sales.rfq_cells c
      LEFT JOIN sales.rfq_prices p ON p.cell_id = c.id
      LEFT JOIN sales.rfq_attachments a ON a.cell_id = c.id
      LEFT JOIN sales.rfq_email_links e ON e.cell_id = c.id
      LEFT JOIN users u ON u.id = e.user_id
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
  let outlookMessageIds: string[];
  try { outlookMessageIds = JSON.parse(req.body.outlookMessageIds || "[]"); } catch {
    return res.status(400).json({ error: "Invalid Outlook message ids" });
  }
  if (!Number.isSafeInteger(clientId) || !Number.isSafeInteger(productId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(weekStart || "") || !/^[A-Z]$/.test(locationCode || "") || !["final", "email"].includes(status) ||
      !Array.isArray(prices) || prices.some((p) => !Number.isFinite(Number(p.quantity)) || Number(p.quantity) <= 0 || !Number.isFinite(Number(p.price)) || Number(p.price) < 0) ||
      !Array.isArray(outlookMessageIds) || outlookMessageIds.length > 5 ||
      outlookMessageIds.some((id) => typeof id !== "string" || !id || id.length > 1000)) {
    return res.status(400).json({ error: "Invalid RFQ cell data" });
  }
  let outlookMessages: Awaited<ReturnType<typeof getOutlookMessage>>[] = [];
  try {
    for (const messageId of [...new Set(outlookMessageIds)]) {
      outlookMessages.push(await getOutlookMessage(req.user!.id, messageId));
    }
  } catch (error) {
    console.error("Error validating Outlook messages:", error);
    return res.status(400).json({ error: "Unable to access one of the selected Outlook messages" });
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
      const contentType = getStoredContentType(file);
      await uploadBufferToS3({ key, buffer: file.buffer, contentType });
      await db.query(`INSERT INTO sales.rfq_attachments (cell_id, file_name, content_type, s3_key, size_bytes)
        VALUES ($1, $2, $3, $4, $5)`, [cellId, file.originalname, contentType, key, file.size]);
    }
    for (const message of outlookMessages) {
      await db.query(
        `INSERT INTO sales.rfq_email_links
          (cell_id, user_id, microsoft_message_id, subject, sender_name,
           sender_email, received_at, web_link)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (cell_id, user_id, microsoft_message_id) DO UPDATE SET
           subject = EXCLUDED.subject,
           sender_name = EXCLUDED.sender_name,
           sender_email = EXCLUDED.sender_email,
           received_at = EXCLUDED.received_at,
           web_link = EXCLUDED.web_link`,
        [
          cellId,
          req.user!.id,
          message.id,
          message.subject || "(Sans objet)",
          message.from?.emailAddress?.name || "",
          message.from?.emailAddress?.address || "",
          message.receivedDateTime || null,
          message.webLink,
        ],
      );
    }
    await db.query("COMMIT");
    return res.json({ id: cellId });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Error saving RFQ cell:", error);
    return res.status(500).json({ error: "Failed to save RFQ cell" });
  } finally { db.release(); }
});

router.patch("/rfq-cells/move-batch", async (req, res) => {
  const clientId = Number(req.body?.clientId);
  const moves: unknown[] = Array.isArray(req.body?.moves) ? req.body.moves : [];

  if (
    !Number.isSafeInteger(clientId) || clientId <= 0 ||
    moves.length < 2 || moves.length > 50 ||
    moves.some((move: unknown) => {
      const item = move as Record<string, unknown>;
      return (
        !Number.isSafeInteger(Number(item.cellId)) || Number(item.cellId) <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(item.weekStart || "")) ||
        !/^[A-Z]$/.test(String(item.locationCode || ""))
      );
    })
  ) {
    return res.status(400).json({ error: "Invalid RFQ cell moves" });
  }

  const normalizedMoves: Array<{ cellId: number; weekStart: string; locationCode: string }> =
    moves.map((move) => {
      const item = move as Record<string, unknown>;
      return {
        cellId: Number(item.cellId),
        weekStart: String(item.weekStart),
        locationCode: String(item.locationCode),
      };
    });
  const cellIds = normalizedMoves.map((move) => move.cellId);
  const targetKeys = normalizedMoves.map((move) => `${move.weekStart}:${move.locationCode}`);

  if (new Set(cellIds).size !== cellIds.length || new Set(targetKeys).size !== targetKeys.length) {
    return res.status(400).json({ error: "Duplicate RFQ source or destination" });
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const sourceResult = await db.query(
      `SELECT id, product_id FROM sales.rfq_cells
       WHERE client_id = $1 AND id = ANY($2::bigint[])
       FOR UPDATE`,
      [clientId, cellIds],
    );
    if (sourceResult.rowCount !== normalizedMoves.length) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "One or more RFQ cells were not found" });
    }

    const productIds = new Set(sourceResult.rows.map((row) => String(row.product_id)));
    if (productIds.size !== 1) {
      await db.query("ROLLBACK");
      return res.status(400).json({ error: "Selected RFQ cells must belong to the same product" });
    }
    const productId = sourceResult.rows[0].product_id;

    const existingResult = await db.query(
      `SELECT id, week_start::text, location_code
       FROM sales.rfq_cells
       WHERE client_id = $1 AND product_id = $2
       FOR UPDATE`,
      [clientId, productId],
    );
    const selectedIds = new Set(cellIds);
    const occupiedByOtherCell = new Set(
      existingResult.rows
        .filter((row) => !selectedIds.has(Number(row.id)))
        .map((row) => `${row.week_start}:${row.location_code}`),
    );
    if (targetKeys.some((key) => occupiedByOtherCell.has(key))) {
      await db.query("ROLLBACK");
      return res.status(409).json({ error: "One or more destination RFQ cells are occupied" });
    }

    // Temporarily move each row out of the visible calendar to avoid transient
    // unique-key collisions when a group shifts into another selected cell's position.
    for (const [index, move] of normalizedMoves.entries()) {
      await db.query(
        `UPDATE sales.rfq_cells
         SET week_start = DATE '1000-01-01' + $1::integer, location_code = '#'
         WHERE id = $2`,
        [index, move.cellId],
      );
    }
    for (const move of normalizedMoves) {
      await db.query(
        `UPDATE sales.rfq_cells
         SET week_start = $1, location_code = $2, updated_at = NOW()
         WHERE id = $3`,
        [move.weekStart, move.locationCode, move.cellId],
      );
    }

    await db.query("COMMIT");
    return res.json({ moved: normalizedMoves.length });
  } catch (error) {
    await db.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "One or more destination RFQ cells are occupied" });
    }
    console.error("Error moving RFQ cells:", error);
    return res.status(500).json({ error: "Failed to move RFQ cells" });
  } finally {
    db.release();
  }
});

router.patch("/rfq-cells/:cellId/move", async (req, res) => {
  const cellId = Number(req.params.cellId);
  const clientId = Number(req.body?.clientId);
  const productId = Number(req.body?.productId);
  const weekStart = typeof req.body?.weekStart === "string" ? req.body.weekStart : "";
  const locationCode = typeof req.body?.locationCode === "string" ? req.body.locationCode : "";

  if (
    !Number.isSafeInteger(cellId) || cellId <= 0 ||
    !Number.isSafeInteger(clientId) || clientId <= 0 ||
    !Number.isSafeInteger(productId) || productId <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(weekStart) ||
    !/^[A-Z]$/.test(locationCode)
  ) {
    return res.status(400).json({ error: "Invalid RFQ cell destination" });
  }

  try {
    const product = await pool.query(
      "SELECT 1 FROM sales.products WHERE id = $1 AND client_id = $2 AND is_active = TRUE",
      [productId, clientId],
    );
    if (!product.rowCount) {
      return res.status(400).json({ error: "Destination product does not belong to client" });
    }

    const moved = await pool.query(
      `UPDATE sales.rfq_cells
       SET product_id = $1, week_start = $2, location_code = $3, updated_at = NOW()
       WHERE id = $4 AND client_id = $5
       RETURNING id, client_id, product_id, week_start::text, location_code`,
      [productId, weekStart, locationCode, cellId, clientId],
    );
    if (!moved.rowCount) {
      return res.status(404).json({ error: "RFQ cell not found" });
    }
    return res.json({ cell: moved.rows[0] });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "Destination RFQ cell is already occupied" });
    }
    console.error("Error moving RFQ cell:", error);
    return res.status(500).json({ error: "Failed to move RFQ cell" });
  }
});

router.delete("/rfq-cells/:cellId", async (req, res) => {
  const cellId = Number(req.params.cellId);
  if (!Number.isSafeInteger(cellId) || cellId <= 0) {
    return res.status(400).json({ error: "Invalid RFQ cell id" });
  }

  const db = await pool.connect();
  let attachmentKeys: string[] = [];
  try {
    await db.query("BEGIN");
    const attachments = await db.query(
      "SELECT s3_key FROM sales.rfq_attachments WHERE cell_id = $1",
      [cellId],
    );
    attachmentKeys = attachments.rows.map((row) => String(row.s3_key));
    const deleted = await db.query(
      "DELETE FROM sales.rfq_cells WHERE id = $1 RETURNING id",
      [cellId],
    );
    if (!deleted.rowCount) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "RFQ cell not found" });
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Error deleting RFQ cell:", error);
    return res.status(500).json({ error: "Failed to delete RFQ cell" });
  } finally {
    db.release();
  }

  const cleanupResults = await Promise.allSettled(
    attachmentKeys.map((key) => deleteObjectFromS3(key)),
  );
  cleanupResults.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`Failed to delete RFQ attachment ${attachmentKeys[index]} from S3:`, result.reason);
    }
  });

  return res.status(204).send();
});

router.get("/rfq-attachments/:attachmentId", async (req, res) => {
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isSafeInteger(attachmentId)) return res.status(400).json({ error: "Invalid attachment id" });
  try {
    const result = await pool.query("SELECT file_name, content_type, s3_key FROM sales.rfq_attachments WHERE id = $1", [attachmentId]);
    if (!result.rowCount) return res.status(404).json({ error: "Attachment not found" });
    const file = result.rows[0];
    const disposition = getEmailExtension(String(file.file_name)) ? "attachment" : "inline";
    const url = await getSignedUrlForKey(file.s3_key, {
      responseContentDisposition: `${disposition}; filename="${String(file.file_name).replace(/["\\]/g, "_")}"`,
      responseContentType: file.content_type,
    });
    return res.json({ url });
  } catch (error) {
    console.error("Error opening RFQ attachment:", error);
    return res.status(500).json({ error: "Failed to open attachment" });
  }
});

export default router;
