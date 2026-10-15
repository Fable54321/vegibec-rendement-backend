export interface SeedSupplier {
  id: number;
  name: string;
  is_active: boolean;
}

export interface SeedLot {
  id: number;
  cultivar_id: number;
  supplier_id: number;
  supplier_lot_number: string | null;
  germination_percentage: number | null;
  thousand_seed_weight_grams: number | null;
  notes: string | null;
  created_at: string;
}

export interface CreateSeedLotInput {
  cultivar_id: number;
  supplier_id: number;
  supplier_lot_number?: string | null;
  germination_percentage?: number | null;
  thousand_seed_weight_grams?: number | null;
  notes?: string | null;
}

export interface SeedPurchase {
  id: number;
  reference_number: string | null;
  purchase_date: string | null;
  reception_date: string;
  quantity_m: number;
  price_per_thousand: number | null;
  total_cost: number | null;
  packaging: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  seed_lot_id: number;
}

export interface SeedPurchaseWithLot extends SeedPurchase {
  cultivar_id: number;
  supplier_id: number;
  supplier_lot_number: string | null;
  germination_percentage: number | null;
  thousand_seed_weight_grams: number | null;
}

export interface CreateSeedPurchaseInput {
  seed_lot_id: number;
  reference_number?: string | null;
  purchase_date?: string | null;
  reception_date: string;
  quantity_m: number;
  price_per_thousand?: number | null;
  total_cost?: number | null;
  packaging?: string | null;
  notes?: string | null;
}

export interface SeedInventory {
  id: number;
  seed_purchase_id: number;
  cultivar_id: number;
  quantity_m: number;
  reserved_quantity_m: number;
  available_quantity_m: number;
  last_updated: string;
}

export interface SeedInventorySummary {
  cultivar_id: number;
  total_quantity_m: number;
  reserved_quantity_m: number;
  available_quantity_m: number;
  number_of_lots: number;
}

export interface SeedInventoryLot {
  seed_lot_id: number;
  cultivar_id: number;
  supplier_id: number;
  supplier_lot_number: string | null;
  germination_percentage: number | null;
  quantity_m: number;
  reserved_quantity_m: number;
  available_quantity_m: number;
}

export interface SeedInventoryAdjustment {
  seed_lot_id: number;
  // Positive values add stock; negative values remove it.
  adjustment_m: number;
  reason: string;
}
