import { Router } from "express";
import { pool } from "../../db";

const router = Router();

router.post("/products", async (req, res) => {
  const { productName, productCode } = req.body;

  if (!productName || !productCode) {
    return res.status(400).json({
      error: "productName et productCode sont requis",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Insert product
    const productResult = await client.query(
      `
      INSERT INTO warehouse.products (product_name, product_code)
      VALUES ($1, $2)
      RETURNING id, product_code
      `,
      [productName, productCode],
    );

    const product = productResult.rows[0];

    const baseUrl = process.env.BASE_URL || "http://localhost:5173";

    const qrActions = [
      {
        type: "info",
        value: `${baseUrl}/produits/${product.product_code}`,
      },
      {
        type: "add",
        value: `${baseUrl}/ajouter-produit/${product.product_code}/add`,
      },
      {
        type: "remove",
        value: `${baseUrl}/retirer-produit/${product.product_code}/remove`,
      },
    ];

    for (const action of qrActions) {
      await client.query(
        `
        INSERT INTO warehouse.product_qr_actions (product_id, action_type, qr_value)
        VALUES ($1, $2, $3)
        `,
        [product.id, action.type, action.value],
      );
    }

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Produit créé avec succès",
      product,
    });
  } catch (err: any) {
    await client.query("ROLLBACK");

    console.error("Erreur création produit:", err);

    if (err.code === "23505") {
      return res.status(409).json({
        error: "Ce product_code existe déjà",
      });
    }

    return res.status(500).json({
      error: "Erreur serveur",
    });
  } finally {
    client.release();
  }
});

export default router;
