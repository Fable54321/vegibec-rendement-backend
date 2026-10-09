import type { RequestHandler } from "express";

import * as seedService from "./seedInventoryService";

import type {
  CreateSeedPurchaseInput,
} from "./seedInventoryTypes";

// ==========================================
// GET PURCHASES
// ==========================================

export const getPurchases: RequestHandler = async (
  req,
  res,
) => {
  try {
    const purchases = await seedService.getPurchases();

    res.status(200).json(purchases);
  } catch (error) {
    console.error("Error fetching seed purchases:", error);

    res.status(500).json({
      error: "Failed to fetch seed purchases",
    });
  }
};

// ==========================================
// CREATE PURCHASE / RECEPTION
// ==========================================

export const createPurchase: RequestHandler = async (
  req,
  res,
) => {
  try {
    const input = (req.body ?? {}) as Partial<CreateSeedPurchaseInput>;

    if (
      typeof input.cultivar_id !== "number" ||
      !Number.isSafeInteger(input.cultivar_id) ||
      input.cultivar_id <= 0
    ) {
      res.status(400).json({
        error: "A valid cultivar_id is required",
      });
      return;
    }

    if (
      typeof input.supplier_id !== "number" ||
      !input.supplier_id ||
      typeof input.supplier_lot_number !== "string" ||
      !input.supplier_lot_number.trim()
    ) {
      res.status(400).json({
        error: "Supplier and supplier lot number are required",
      });
      return;
    }

    if (
      typeof input.reception_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.reception_date) ||
      Number.isNaN(
        Date.parse(`${input.reception_date}T00:00:00Z`),
      )
    ) {
      res.status(400).json({
        error: "A valid reception_date is required",
      });
      return;
    }

    if (
      typeof input.quantity_m !== "number" ||
      !Number.isFinite(input.quantity_m) ||
      input.quantity_m <= 0 ||
      Math.round(input.quantity_m * 1000) !==
        input.quantity_m * 1000
    ) {
      res.status(400).json({
        error:
          "quantity_m must be a positive number with at most 3 decimal places",
      });
      return;
    }

    if (
      [
        input.price_per_thousand,
        input.total_cost,
        input.thousand_seed_weight_grams,
      ].some(
        (value) =>
          value != null &&
          (typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0),
      )
    ) {
      res.status(400).json({
        error: "Invalid price, cost, or thousand-seed weight",
      });
      return;
    }

    if (
      input.thousand_seed_weight_grams != null &&
      input.thousand_seed_weight_grams <= 0
    ) {
      res.status(400).json({
        error: "Thousand-seed weight must be positive",
      });
      return;
    }

    if (
      input.germination_percentage != null &&
      (typeof input.germination_percentage !== "number" ||
        !Number.isFinite(input.germination_percentage) ||
        input.germination_percentage < 0 ||
        input.germination_percentage > 100)
    ) {
      res.status(400).json({
        error: "Germination percentage must be between 0 and 100",
      });
      return;
    }

    const purchase = await seedService.createPurchase(
      input as CreateSeedPurchaseInput,
    );

    res.status(201).json(purchase);
  } catch (error: any) {
    console.error("Error creating seed purchase:", error);

    if (error.code === "23503") {
      res.status(400).json({
        error: "Invalid cultivar reference",
      });
      return;
    }

    if (
      error.code === "23514" ||
      error.code === "22003" ||
      error.code === "22007" ||
      error.code === "22008"
    ) {
      res.status(400).json({
        error: "Purchase contains invalid values",
      });
      return;
    }

    res.status(500).json({
      error: "Failed to create seed purchase",
    });
  }
};
