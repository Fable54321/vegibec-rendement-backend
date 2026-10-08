import type { RequestHandler } from "express";

import * as seedService from "./seedInventoryService";

import type {
  SeedInventoryAdjustment,
} from "./seedInventoryTypes";

// ==========================================
// GET INVENTORY BY CULTIVAR
// ==========================================

export const getInventory: RequestHandler = async (
  req,
  res,
) => {
  try {
    const inventory = await seedService.getInventory();

    res.status(200).json(inventory);
  } catch (error) {
    console.error("Error fetching seed inventory:", error);

    res.status(500).json({
      error: "Failed to fetch seed inventory",
    });
  }
};

// ==========================================
// GET INVENTORY FOR ONE CULTIVAR
// ==========================================

export const getCultivarInventory: RequestHandler = async (
  req,
  res,
) => {
  try {
    const cultivarId = Number(req.params.cultivarId);

    if (
      !Number.isSafeInteger(cultivarId) ||
      cultivarId <= 0
    ) {
      res.status(400).json({
        error: "Invalid cultivar ID",
      });
      return;
    }

    const inventory =
      await seedService.getCultivarInventory(cultivarId);

    res.status(200).json(inventory);
  } catch (error) {
    console.error("Error fetching cultivar inventory:", error);

    res.status(500).json({
      error: "Failed to fetch cultivar inventory",
    });
  }
};

// ==========================================
// ADJUST INVENTORY
// ==========================================

export const adjustInventory: RequestHandler = async (
  req,
  res,
) => {
  try {
    const input = req.body as SeedInventoryAdjustment;

    if (
      !Number.isSafeInteger(input.seed_lot_id) ||
      input.seed_lot_id <= 0
    ) {
      res.status(400).json({
        error: "A valid seed_lot_id is required",
      });
      return;
    }

    if (
      typeof input.adjustment_m !== "number" ||
      !Number.isFinite(input.adjustment_m) ||
      input.adjustment_m === 0 ||
      Math.round(input.adjustment_m * 1000) !==
        input.adjustment_m * 1000
    ) {
      res.status(400).json({
        error:
          "adjustment_m must be a non-zero number with at most 3 decimal places",
      });
      return;
    }

    if (
      typeof input.reason !== "string" ||
      !input.reason.trim()
    ) {
      res.status(400).json({
        error: "A reason is required",
      });
      return;
    }

    const result = await seedService.adjustInventory({
      ...input,
      reason: input.reason.trim(),
    });

    res.status(200).json(result);
  } catch (error: any) {
    console.error("Error adjusting seed inventory:", error);

    if (error.message === "SEED_LOT_INVENTORY_NOT_FOUND") {
      res.status(404).json({
        error: "Seed lot inventory not found",
      });
      return;
    }

    if (error.message === "INSUFFICIENT_AVAILABLE_STOCK") {
      res.status(409).json({
        error:
          "Insufficient unreserved stock for this adjustment",
      });
      return;
    }

    res.status(500).json({
      error: "Failed to adjust seed inventory",
    });
  }
};