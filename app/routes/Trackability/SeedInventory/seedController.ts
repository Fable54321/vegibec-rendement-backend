import type { RequestHandler } from "express";

import * as seedService from "./seedInventoryService";
import type { CreateSeedLotInput } from "./seedInventoryTypes";

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function hasAtMostDecimalPlaces(
  value: number,
  decimalPlaces: number,
): boolean {
  const factor = 10 ** decimalPlaces;
  return Math.abs(value * factor - Math.round(value * factor)) < 1e-7;
}

// ==========================================
// GET ALL SUPPLIER LOTS
// ==========================================

export const getLots: RequestHandler = async (
  req,
  res,
) => {
  try {
    const lots = await seedService.getLots();

    res.status(200).json(lots);
  } catch (error) {
    console.error("Error fetching seed lots:", error);

    res.status(500).json({
      error: "Failed to fetch seed lots",
    });
  }
};

// ==========================================
// GET SUPPLIER LOT BY ID
// ==========================================

export const getLotById: RequestHandler = async (
  req,
  res,
) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({
        error: "Invalid seed lot ID",
      });
      return;
    }

    const lot = await seedService.getLotById(id);

    if (!lot) {
      res.status(404).json({
        error: "Seed lot not found",
      });
      return;
    }

    res.status(200).json(lot);
  } catch (error) {
    console.error("Error fetching seed lot:", error);

    res.status(500).json({
      error: "Failed to fetch seed lot",
    });
  }
};

// ==========================================
// CREATE SUPPLIER LOT
// ==========================================

export const createLot: RequestHandler = async (
  req,
  res,
) => {
  try {
    const input = (req.body ?? {}) as Partial<CreateSeedLotInput>;
    const cultivarId = input.cultivar_id;
    const supplierId = input.supplier_id;

    if (!isPositiveInteger(cultivarId)) {
      res.status(400).json({
        error: "A valid cultivar_id is required",
      });
      return;
    }

    if (!isPositiveInteger(supplierId)) {
      res.status(400).json({
        error: "A valid supplier_id is required",
      });
      return;
    }

    if (
      input.supplier_lot_number !== undefined &&
      input.supplier_lot_number !== null &&
      (typeof input.supplier_lot_number !== "string" ||
        !input.supplier_lot_number.trim() ||
        input.supplier_lot_number.trim().length > 150)
    ) {
      res.status(400).json({
        error:
          "supplier_lot_number must be null or a non-empty string of at most 150 characters",
      });
      return;
    }

    if (
      input.germination_percentage != null &&
      (typeof input.germination_percentage !== "number" ||
        !Number.isFinite(input.germination_percentage) ||
        input.germination_percentage < 0 ||
        input.germination_percentage > 100 ||
        !hasAtMostDecimalPlaces(
          input.germination_percentage,
          2,
        ))
    ) {
      res.status(400).json({
        error:
          "germination_percentage must be null or between 0 and 100 with at most 2 decimal places",
      });
      return;
    }

    if (
      input.thousand_seed_weight_grams != null &&
      (typeof input.thousand_seed_weight_grams !== "number" ||
        !Number.isFinite(input.thousand_seed_weight_grams) ||
        input.thousand_seed_weight_grams <= 0 ||
        input.thousand_seed_weight_grams >= 100_000_000 ||
        !hasAtMostDecimalPlaces(
          input.thousand_seed_weight_grams,
          4,
        ))
    ) {
      res.status(400).json({
        error:
          "thousand_seed_weight_grams must be null or a positive numeric(12,4) value",
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

    const lot = await seedService.createLot({
      cultivar_id: cultivarId,
      supplier_id: supplierId,
      supplier_lot_number:
        typeof input.supplier_lot_number === "string"
          ? input.supplier_lot_number.trim()
          : null,
      germination_percentage:
        input.germination_percentage ?? null,
      thousand_seed_weight_grams:
        input.thousand_seed_weight_grams ?? null,
      notes: input.notes ?? null,
    });

    res.status(201).json(lot);
  } catch (error: any) {
    if (error.code === "23505") {
      res.status(409).json({
        error:
          "A seed lot with this cultivar, supplier, and lot number already exists",
      });
      return;
    }

    if (error.code === "23503") {
      res.status(400).json({
        error: "The referenced cultivar or supplier does not exist",
      });
      return;
    }

    if (error.code === "23514" || error.code === "22003") {
      res.status(400).json({
        error: "Seed lot contains invalid values",
      });
      return;
    }

    console.error("Error creating seed lot:", error);

    res.status(500).json({
      error: "Failed to create seed lot",
    });
  }
};
