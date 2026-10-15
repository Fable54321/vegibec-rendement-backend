import type { RequestHandler } from "express";

import * as seedService from "./seedInventoryService";

import type {
  CreateSeedPurchaseInput,
} from "./seedInventoryTypes";

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isValidDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function isDecimal(
  value: unknown,
  scale: number,
  maximumExclusive: number,
  positive: boolean,
): value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (positive ? value <= 0 : value < 0) ||
    value >= maximumExclusive
  ) {
    return false;
  }

  const factor = 10 ** scale;
  return Math.abs(value * factor - Math.round(value * factor)) < 1e-7;
}

function isNullableText(
  value: unknown,
  maximumLength?: number,
): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      (maximumLength === undefined ||
        value.trim().length <= maximumLength))
  );
}

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

    if (!isPositiveInteger(input.seed_lot_id)) {
      res.status(400).json({
        error: "A valid seed_lot_id is required",
      });
      return;
    }

    if (
      !isNullableText(input.reference_number, 100)
    ) {
      res.status(400).json({
        error:
          "reference_number must be null or a non-empty string of at most 100 characters",
      });
      return;
    }

    if (!isValidDate(input.reception_date)) {
      res.status(400).json({
        error:
          "reception_date must be a valid date in YYYY-MM-DD format",
      });
      return;
    }

    if (
      input.purchase_date !== undefined &&
      input.purchase_date !== null &&
      !isValidDate(input.purchase_date)
    ) {
      res.status(400).json({
        error:
          "purchase_date must be null or a valid date in YYYY-MM-DD format",
      });
      return;
    }

    if (
      !isDecimal(input.quantity_m, 3, 100_000_000_000, true)
    ) {
      res.status(400).json({
        error:
          "quantity_m must be a positive numeric(14,3) value",
      });
      return;
    }

    if (
      input.price_per_thousand != null &&
      !isDecimal(
        input.price_per_thousand,
        4,
        100_000_000,
        false,
      )
    ) {
      res.status(400).json({
        error:
          "price_per_thousand must be null or a non-negative numeric(12,4) value",
      });
      return;
    }

    if (
      input.total_cost != null &&
      !isDecimal(
        input.total_cost,
        2,
        1_000_000_000_000,
        false,
      )
    ) {
      res.status(400).json({
        error:
          "total_cost must be null or a non-negative numeric(14,2) value",
      });
      return;
    }

    if (!isNullableText(input.packaging, 100)) {
      res.status(400).json({
        error:
          "packaging must be null or a non-empty string of at most 100 characters",
      });
      return;
    }

    if (
      input.notes !== undefined &&
      input.notes !== null &&
      typeof input.notes !== "string"
    ) {
      res.status(400).json({
        error: "notes must be a string or null",
      });
      return;
    }

    const purchase = await seedService.createPurchase({
      seed_lot_id: input.seed_lot_id,
      reference_number:
        typeof input.reference_number === "string"
          ? input.reference_number.trim()
          : null,
      purchase_date: input.purchase_date ?? null,
      reception_date: input.reception_date,
      quantity_m: input.quantity_m,
      price_per_thousand: input.price_per_thousand ?? null,
      total_cost: input.total_cost ?? null,
      packaging:
        typeof input.packaging === "string"
          ? input.packaging.trim()
          : null,
      notes: input.notes ?? null,
    });

    res.status(201).json(purchase);
  } catch (error: any) {
    console.error("Error creating seed purchase:", error);

    if (error.code === "23505") {
      res.status(409).json({
        error: "A purchase with this reference number already exists",
      });
      return;
    }

    if (error.code === "23503") {
      res.status(400).json({
        error: "The referenced seed lot does not exist",
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
