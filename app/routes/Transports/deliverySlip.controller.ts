import type { Request, Response } from "express";
import { pool } from "../../db";
import {
  createDeliverySlipPdf,
  type DeliverySlipOrder,
  type DeliverySlipOrderItem,
} from "./deliverySlipPdf";

const positiveId = (value: unknown) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const safeFilenamePart = (value: unknown) =>
  String(value ?? "commande")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "commande";

export async function getDeliverySlip(req: Request, res: Response) {
  const orderId = positiveId(req.params.orderId);
  if (!orderId) {
    return res
      .status(400)
      .json({ message: "Le num\u00e9ro de commande est invalide." });
  }

  try {
    const [orderResult, itemsResult] = await Promise.all([
      pool.query<Omit<DeliverySlipOrder, "items">>(
        `SELECT id, order_reference, client_name, client_number, shipping_address,
                sold_by, seller_name, customer_po, ordered_date, loaded_date,
                shipped_date, carrier
         FROM sales.orders
         WHERE id = $1
         LIMIT 1`,
        [orderId],
      ),
      pool.query<DeliverySlipOrderItem>(
        `SELECT id, product_name, product_code, quantity_ordered,
                actual_pallets, planned_pallets, pallet_type, origin
         FROM sales.order_items
         WHERE order_id = $1
         ORDER BY id`,
        [orderId],
      ),
    ]);

    if (!orderResult.rowCount) {
      return res.status(404).json({ message: "Commande introuvable." });
    }

    const order: DeliverySlipOrder = {
      ...orderResult.rows[0],
      items: itemsResult.rows,
    };
    const pdf = await createDeliverySlipPdf(order);
    const filename = `bon-livraison-${safeFilenamePart(order.order_reference)}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdf.length.toString());
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(pdf);
  } catch (error) {
    console.error(
      `Error generating delivery slip for order ${orderId}:`,
      error,
    );
    return res
      .status(500)
      .json({
        message: "Impossible de g\u00e9n\u00e9rer le bon de livraison.",
      });
  }
}
