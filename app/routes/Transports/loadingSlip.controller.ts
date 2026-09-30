import type { Request, Response } from "express";
import { pool } from "../../db";
import {
  createLoadingSlipPdf,
  type LoadingSlipOrder,
  type LoadingSlipOrderItem,
} from "./loadingSlipPdf";

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

export async function getLoadingSlip(req: Request, res: Response) {
  const orderId = positiveId(req.params.orderId);
  if (!orderId) {
    return res
      .status(400)
      .json({ message: "Le numéro de commande est invalide." });
  }

  try {
    const [orderResult, itemsResult] = await Promise.all([
      pool.query<Omit<LoadingSlipOrder, "items">>(
        `SELECT id, order_reference, client_name, client_number, shipping_address,
                sold_by, seller_name, trip_number, customer_po, loaded_date,
                shipped_date, carrier, transport_temperature
         FROM sales.orders
         WHERE id = $1
         LIMIT 1`,
        [orderId],
      ),
      pool.query<LoadingSlipOrderItem>(
        `SELECT i.id, i.product_name, i.product_code, i.quantity_ordered,
                i.quantity_per_pallet, i.actual_pallets, i.planned_pallets,
                i.pallet_type, fp.weight AS product_weight
         FROM sales.order_items i
         LEFT JOIN public.finished_product fp ON fp.id = i.finished_product_id
         WHERE i.order_id = $1
         ORDER BY i.id`,
        [orderId],
      ),
    ]);

    if (!orderResult.rowCount) {
      return res.status(404).json({ message: "Commande introuvable." });
    }

    const order: LoadingSlipOrder = {
      ...orderResult.rows[0],
      items: itemsResult.rows,
    };
    const pdf = await createLoadingSlipPdf(order);
    const filename = `bon-chargement-${safeFilenamePart(order.order_reference)}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdf.length.toString());
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(pdf);
  } catch (error) {
    console.error(`Error generating loading slip for order ${orderId}:`, error);
    return res
      .status(500)
      .json({ message: "Impossible de générer le bon de chargement." });
  }
}
