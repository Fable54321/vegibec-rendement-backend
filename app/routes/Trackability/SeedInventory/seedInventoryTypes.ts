export interface SeedLot {
  id: number;
  cultivar_id: number;
  supplier: string;
  supplier_lot_number: string;
  germination_percentage: number | null;
  thousand_seed_weight_grams: number | null;
  notes: string | null;
  created_at: string;
}

export interface SeedPurchase {
  id: number;
  seed_lot_id: number;
  cultivar_id: number;

  purchase_number: string | null;
  purchase_date: string | null;
  reception_date: string;

  supplier: string;
  supplier_lot_number: string;

  quantity_m: number;
  price_per_thousand: number | null;
  total_cost: number | null;

  germination_percentage: number | null;
  thousand_seed_weight_grams: number | null;
  packaging: string | null;

  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSeedPurchaseInput {
  cultivar_id: number;

  purchase_number?: string | null;
  purchase_date?: string | null;
  reception_date: string;

  supplier: string;
  supplier_lot_number: string;

  quantity_m: number;
  price_per_thousand?: number | null;
  total_cost?: number | null;

  germination_percentage?: number | null;
  thousand_seed_weight_grams?: number | null;
  packaging?: string | null;

  notes?: string | null;
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

  supplier: string;
  supplier_lot_number: string;

  germination_percentage: number | null;

  quantity_m: number;
  reserved_quantity_m: number;
  available_quantity_m: number;
}

export interface SeedInventoryAdjustment {
  seed_lot_id: number;

  // Positive = add stock
  // Negative = remove stock
  adjustment_m: number;

  reason: string;
}