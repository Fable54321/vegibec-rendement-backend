import type { RequestHandler } from "express";

import * as seedService from "./seedInventoryService";

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