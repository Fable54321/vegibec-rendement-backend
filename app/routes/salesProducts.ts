import { Router } from "express";
import { pool } from "../db";

const router = Router();

router.get("/clients/:clientId/products", async (req, res) => {
  const clientId = Number(req.params.clientId);

  if (!Number.isSafeInteger(clientId) || clientId <= 0) {
    return res.status(400).json({ error: "Invalid client id" });
  }

  try {
    const clientResult = await pool.query(
      `
        SELECT id, name
        FROM sales.clients
        WHERE id = $1
      `,
      [clientId],
    );

    if (clientResult.rowCount === 0) {
      return res.status(404).json({ error: "Client not found" });
    }

    const productsResult = await pool.query(
      `
        SELECT id, client_id, name, display_order
        FROM sales.products
        WHERE client_id = $1
          AND is_active = TRUE
        ORDER BY display_order, name, id
      `,
      [clientId],
    );

    return res.status(200).json({
      client: clientResult.rows[0],
      products: productsResult.rows,
    });
  } catch (error) {
    console.error("Error fetching products for client:", error);
    return res.status(500).json({ error: "Failed to fetch client products" });
  }
});

export default router;
