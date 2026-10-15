import { Router } from "express";

import { requireAppRole } from "../../../middleware/auth";

import * as purchases from "./seedPurchaseController";
import * as lots from "./seedController";
import * as inventory from "./seedInventoryController";
import suppliers from "./seedSuppliers";

const router = Router();

// ==========================================
// PURCHASES / RECEPTIONS
// ==========================================

router.get(
  "/purchases",
  requireAppRole("main", [
    "admin",
    "user",
    "guest",
  ]),
  purchases.getPurchases,
);

router.post(
  "/purchases",
  requireAppRole("main", [
    "admin",
    "user",
  ]),
  purchases.createPurchase,
);

// ==========================================
// SEED LOTS
// ==========================================

router.post(
  "/lots",
  requireAppRole("main", [
    "admin",
    "user",
  ]),
  lots.createLot,
);

router.get(
  "/lots",
  requireAppRole("main", [
    "admin",
    "user",
    "guest",
  ]),
  lots.getLots,
);

router.get(
  "/lots/:id",
  requireAppRole("main", [
    "admin",
    "user",
    "guest",
  ]),
  lots.getLotById,
);

// ==========================================
// INVENTORY
// ==========================================

router.get(
  "/inventory",
  requireAppRole("main", [
    "admin",
    "user",
    "guest",
  ]),
  inventory.getInventory,
);

router.get(
  "/inventory/:cultivarId",
  requireAppRole("main", [
    "admin",
    "user",
    "guest",
  ]),
  inventory.getCultivarInventory,
);

router.post(
  "/inventory/adjustments",
  requireAppRole("main", ["admin"]),
  inventory.adjustInventory,
);

// ==========================================
// SUPPLIERS
// ==========================================

router.use("/suppliers", suppliers);

export default router;
