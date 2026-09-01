import type { Request, Response } from "express";
import crypto from "crypto";
import { pool } from "../../db";
import { geocodeAddress } from "./geocoding.service";

import {
  getRouteMatrix,
  type RouteLocation,
} from "../Transports/osrm.service";

import {
  optimizeRoundTrip,
} from "../Transports/routeOptimizer.service";

interface OptimizeRouteBody {
  locations: RouteLocation[];
}

const transportDocumentRecognitionPrompt = `Read this delivery/order document carefully. The photo is normally upright; mentally rotate it only when the text itself is clearly sideways or upside down. Preserve exact spelling and numbers.

DESTINATION ADDRESS RULE (highest priority): clientName, address, city, province, and postalCode must come from the destination block immediately beside or below the label "Envoyé à :" (also accept "Envoye a:", "Ship to:", or "Deliver to:"). Treat the lines grouped with that label as one block. Do not use an address from "Envoyé par", "Expédié par", "Vendu à", "Facturé à", sender, supplier, warehouse, or company-header blocks. If the destination block is partly readable, return the readable destination fields and null for the others. If there is no destination label or the block is ambiguous, use null rather than selecting another visible address.

ITEM TABLE COLUMN RULE (highest priority for products): identify the table headers first and follow each row vertically under those headers. The value in the "Code" column is the product code and is the only value that may be returned as code. The adjacent "Lot #" / "Lot" column is traceability data, never a product identifier: return it only as lotNumber and never copy it into code, even when it is numeric or looks like a product code. If the Code cell cannot be read confidently, return code as null; do not substitute the lot number, item number, quantity, or any other number. The product is defined by the Code cell, not by Lot # or the item description.

For every item-table row, extract code only from Code, lotNumber only from Lot #, name only from Item, quantityLabel exactly from Qté à charger (for example 3x80), quantity as calculated total units (3x80 = 240), pallets as the numeric value from that row's Palette column, and palletType as its label such as Peco. The top-level pallets must be the sum of the numeric Palette column, not a quantity or the last row. Extract totalWeight only from the value printed next to "Poids total" / "Total weight" on the document; return the numeric pound value and do not calculate it from item rows. Also extract the PO/reference and a faithful transcription. Never invent missing values; use null. French and English documents are expected.`;

export async function analyzeTransportDocument(req: Request, res: Response): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey && !openRouterApiKey) { res.status(503).json({ error: "La reconnaissance intelligente n’est pas configurée." }); return; }
  const imageDataUrl = typeof req.body?.imageDataUrl === "string" ? req.body.imageDataUrl : "";
  if (!/^data:image\/(jpeg|png|webp);base64,/i.test(imageDataUrl) || imageDataUrl.length > 14_000_000) {
    res.status(400).json({ error: "Une image JPEG, PNG ou WebP valide est requise." }); return;
  }
  try {
    if (openRouterApiKey) {
      const openRouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openRouterApiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://vegibec-portail.com", "X-Title": "Vegibec Portail" },
        body: JSON.stringify({
          model: process.env.OPENROUTER_VISION_MODEL || "dots-studio/dots-3-note-preview:free",
          messages: [{ role: "user", content: [
            { type: "text", text: `${transportDocumentRecognitionPrompt}\nReturn JSON only.` },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ] }],
          reasoning: { effort: "none", exclude: true },
          response_format: { type: "json_schema", json_schema: { name: "transport_document", strict: true, schema: {
            type: "object", additionalProperties: false,
            properties: {
              clientName: { type: ["string", "null"] }, address: { type: ["string", "null"] }, city: { type: ["string", "null"] },
              province: { type: ["string", "null"] }, postalCode: { type: ["string", "null"] }, customerPo: { type: ["string", "null"] },
              pallets: { type: ["integer", "null"] }, totalWeight: { type: ["number", "null"] }, rawText: { type: "string" },
              products: { type: "array", items: { type: "object", additionalProperties: false,
                properties: { code: { type: ["string", "null"] }, lotNumber: { type: ["string", "null"] }, name: { type: ["string", "null"] }, quantityLabel: { type: ["string", "null"] }, quantity: { type: ["number", "null"] }, pallets: { type: ["number", "null"] }, palletType: { type: ["string", "null"] }, unit: { type: ["string", "null"] } }, required: ["code", "lotNumber", "name", "quantityLabel", "quantity", "pallets", "palletType", "unit"] } },
            }, required: ["clientName", "address", "city", "province", "postalCode", "customerPo", "pallets", "totalWeight", "rawText", "products"]
          } } }, max_tokens: 2500,
        }),
      });
      const openRouterPayload: any = await openRouterResponse.json();
      if (!openRouterResponse.ok) throw new Error(openRouterPayload?.error?.message || `OpenRouter request failed (${openRouterResponse.status})`);
      const content = openRouterPayload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("OpenRouter returned no document analysis");
      const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      res.json({
        clientName: typeof parsed.clientName === "string" ? parsed.clientName : null,
        address: typeof parsed.address === "string" ? parsed.address : null,
        city: typeof parsed.city === "string" ? parsed.city : null,
        province: typeof parsed.province === "string" ? parsed.province : null,
        postalCode: typeof parsed.postalCode === "string" ? parsed.postalCode : null,
        customerPo: typeof parsed.customerPo === "string" ? parsed.customerPo : null,
        pallets: Number.isSafeInteger(Number(parsed.pallets)) ? Number(parsed.pallets) : null,
        totalWeight: Number.isFinite(Number(parsed.totalWeight)) ? Number(parsed.totalWeight) : null,
        rawText: typeof parsed.rawText === "string" ? parsed.rawText : content,
        products: Array.isArray(parsed.products) ? parsed.products.slice(0, 100).map((product: any) => ({ code: typeof product?.code === "string" ? product.code : null, lotNumber: typeof product?.lotNumber === "string" ? product.lotNumber : null, name: typeof product?.name === "string" ? product.name : null, quantityLabel: typeof product?.quantityLabel === "string" ? product.quantityLabel : null, quantity: Number.isFinite(Number(product?.quantity)) ? Number(product.quantity) : null, pallets: Number.isFinite(Number(product?.pallets)) ? Number(product.pallets) : null, palletType: typeof product?.palletType === "string" ? product.palletType : null, unit: typeof product?.unit === "string" ? product.unit : null })) : [],
        recognitionProvider: "openrouter",
        recognitionModel: openRouterPayload.model,
      });
      return;
    }
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4o",
        input: [{ role: "user", content: [
          { type: "input_text", text: transportDocumentRecognitionPrompt },
          { type: "input_image", image_url: imageDataUrl, detail: "high" },
        ] }],
        text: { format: { type: "json_schema", name: "transport_document", strict: true, schema: {
          type: "object", additionalProperties: false,
          properties: {
            clientName: { type: ["string", "null"] }, address: { type: ["string", "null"] },
            city: { type: ["string", "null"] }, province: { type: ["string", "null"] },
            postalCode: { type: ["string", "null"] }, customerPo: { type: ["string", "null"] },
            pallets: { type: ["integer", "null"] }, totalWeight: { type: ["number", "null"] }, rawText: { type: "string" },
            products: { type: "array", items: { type: "object", additionalProperties: false,
              properties: { code: { type: ["string", "null"] }, lotNumber: { type: ["string", "null"] }, name: { type: ["string", "null"] }, quantityLabel: { type: ["string", "null"] }, quantity: { type: ["number", "null"] }, pallets: { type: ["number", "null"] }, palletType: { type: ["string", "null"] }, unit: { type: ["string", "null"] } },
              required: ["code", "lotNumber", "name", "quantityLabel", "quantity", "pallets", "palletType", "unit"] } },
          }, required: ["clientName", "address", "city", "province", "postalCode", "customerPo", "pallets", "totalWeight", "rawText", "products"]
        } } },
        max_output_tokens: 2500,
      }),
    });
    const payload: any = await response.json();
    if (!response.ok) {
      if (payload?.error?.code === "credit_balance_exhausted" || payload?.error?.type === "insufficient_quota") {
        res.status(402).json({ error: "Le compte OpenAI API n’a plus de crédits. Ajoutez des crédits dans la section Billing de la plateforme OpenAI." }); return;
      }
      if (response.status === 401) { res.status(502).json({ error: "La clé OpenAI API du serveur est invalide." }); return; }
      throw new Error(payload?.error?.message || `OpenAI request failed (${response.status})`);
    }
    const outputText = payload.output_text ?? payload.output?.flatMap((item: any) => item.content ?? []).find((item: any) => item.type === "output_text")?.text;
    if (!outputText) throw new Error("OpenAI returned no document analysis");
    res.json(JSON.parse(outputText));
  } catch (error) {
    console.error("OpenAI transport document analysis error:", error);
    res.status(502).json({ error: "La reconnaissance intelligente a échoué. Réessayez avec une photo plus nette." });
  }
}

let transportScanTablesPromise: Promise<void> | null = null;
async function ensureTransportScanTables(): Promise<void> {
  if (transportScanTablesPromise) return transportScanTablesPromise;
  transportScanTablesPromise = pool.query(`
    CREATE TABLE IF NOT EXISTS public.transport_scan_sessions (
      token TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '8 hours'
    );
    CREATE TABLE IF NOT EXISTS public.transport_scan_items (
      id BIGSERIAL PRIMARY KEY,
      session_token TEXT NOT NULL REFERENCES public.transport_scan_sessions(token) ON DELETE CASCADE,
      address_id INTEGER REFERENCES sales.clients_addresses(id),
      pallets INTEGER NOT NULL CHECK (pallets BETWEEN 1 AND 30),
      recognized_text TEXT,
      recognized_client_name TEXT,
      recognized_address TEXT,
      recognized_city TEXT,
      recognized_postal_code TEXT,
      product_matches JSONB NOT NULL DEFAULT '[]'::jsonb,
      estimated_weight NUMERIC(14, 3) NOT NULL DEFAULT 0,
      confirmed BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE public.transport_scan_items ALTER COLUMN address_id DROP NOT NULL;
    ALTER TABLE public.transport_scan_items ADD COLUMN IF NOT EXISTS recognized_text TEXT;
    ALTER TABLE public.transport_scan_items ADD COLUMN IF NOT EXISTS recognized_client_name TEXT;
    ALTER TABLE public.transport_scan_items ADD COLUMN IF NOT EXISTS recognized_address TEXT;
    ALTER TABLE public.transport_scan_items ADD COLUMN IF NOT EXISTS recognized_city TEXT;
    ALTER TABLE public.transport_scan_items ADD COLUMN IF NOT EXISTS recognized_postal_code TEXT;
    ALTER TABLE public.transport_scan_items ADD COLUMN IF NOT EXISTS product_matches JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE public.transport_scan_items ADD COLUMN IF NOT EXISTS estimated_weight NUMERIC(14, 3) NOT NULL DEFAULT 0;
    ALTER TABLE public.transport_scan_items ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE public.transport_scan_items DROP CONSTRAINT IF EXISTS transport_scan_items_pallets_check;
    ALTER TABLE public.transport_scan_items ADD CONSTRAINT transport_scan_items_pallets_check CHECK (pallets BETWEEN 1 AND 999);
    CREATE INDEX IF NOT EXISTS transport_scan_items_session_idx
      ON public.transport_scan_items(session_token, id);
  `).then(() => undefined).catch((error) => { transportScanTablesPromise = null; throw error; });
  return transportScanTablesPromise;
}

export async function createScanSession(req: Request, res: Response): Promise<void> {
  try {
    await ensureTransportScanTables();
    const token = crypto.randomBytes(18).toString("base64url");
    const result = await pool.query(
      `INSERT INTO public.transport_scan_sessions (token, owner_user_id)
       VALUES ($1, $2) RETURNING token, expires_at`,
      [token, req.user!.id],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Create transport scan session error:", error);
    res.status(500).json({ error: "Failed to create scan session" });
  }
}

export async function getScanSession(req: Request, res: Response): Promise<void> {
  try {
    await ensureTransportScanTables();
    const session = await pool.query(
      `SELECT token, expires_at FROM public.transport_scan_sessions
       WHERE token = $1 AND owner_user_id = $2 AND expires_at > NOW()`,
      [req.params.token, req.user!.id],
    );
    if (!session.rows.length) { res.status(404).json({ error: "Scan session not found or expired" }); return; }
    const items = await pool.query(
      `SELECT i.id, i.address_id, i.pallets, i.created_at, i.recognized_text,
              i.recognized_client_name, i.recognized_address, i.recognized_city,
              i.recognized_postal_code, i.product_matches, i.estimated_weight, i.confirmed,
              c.name AS client_name, a.site_name, a.site_number, a.city
       FROM public.transport_scan_items i
       LEFT JOIN sales.clients_addresses a ON a.id = i.address_id
       LEFT JOIN sales.clients c ON c.id = a.client_id
       WHERE i.session_token = $1 ORDER BY i.id`,
      [req.params.token],
    );
    res.json({ ...session.rows[0], items: items.rows });
  } catch (error) {
    console.error("Get transport scan session error:", error);
    res.status(500).json({ error: "Failed to load scan session" });
  }
}

export async function addScanSessionItem(req: Request, res: Response): Promise<void> {
  try {
    await ensureTransportScanTables();
    const addressId = req.body?.addressId == null ? null : Number(req.body.addressId);
    const pallets = Number(req.body?.pallets);
    if ((addressId !== null && (!Number.isSafeInteger(addressId) || addressId < 1)) || !Number.isSafeInteger(pallets) || pallets < 1 || pallets > 999) {
      res.status(400).json({ error: "A valid optional address and pallet count are required" }); return;
    }
    const session = await pool.query(
      `SELECT token FROM public.transport_scan_sessions
       WHERE token = $1 AND owner_user_id = $2 AND expires_at > NOW()`,
      [req.params.token, req.user!.id],
    );
    if (!session.rows.length) { res.status(404).json({ error: "Scan session not found or expired" }); return; }
    if (addressId !== null) {
      const address = await pool.query(`SELECT id FROM sales.clients_addresses WHERE id = $1`, [addressId]);
      if (!address.rows.length) { res.status(404).json({ error: "Client address not found" }); return; }
    }
    const recognizedText = typeof req.body?.recognizedText === "string" ? req.body.recognizedText.slice(0, 50000) : "";
    const products = await pool.query(`SELECT id, full_name, product_code, weight FROM public.finished_product WHERE is_active = true`);
    const recognizedProducts = Array.isArray(req.body?.recognizedProducts) ? req.body.recognizedProducts.slice(0, 100) : [];
    const normalize = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const normalizeCode = (value: unknown) => normalize(value).replace(/\s/g, "");
    const codeCounts = products.rows.reduce((counts: Map<string, number>, product) => {
      const code = normalizeCode(product.product_code);
      if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
    const productsByCode = new Map(products.rows
      .map((product) => [normalizeCode(product.product_code), product] as const)
      .filter(([code]) => code.length > 0 && codeCounts.get(code) === 1));
    const productMatches = recognizedProducts.map((recognized: any) => {
      const code = normalizeCode(recognized?.code);
      const words = normalize(recognized?.name).split(" ").filter((word) => word.length >= 3);
      let match = code ? productsByCode.get(code) ?? null : null;
      let matchMethod: "code" | "name" | null = match ? "code" : null;
      // A recognized code is authoritative. If it is unknown, leave the line
      // unmatched for human confirmation instead of replacing it by name.
      if (!code && words.length) {
        const recognizedName = normalize(recognized?.name);
        const ranked = products.rows.map((product) => {
          const productName = normalize(product.full_name);
          const matchedWords = words.filter((word) => productName.split(" ").includes(word)).length;
          return { product, exact: productName === recognizedName, matchedWords };
        }).sort((a, b) => Number(b.exact) - Number(a.exact) || b.matchedWords - a.matchedWords);
        const best = ranked[0];
        const requiredWords = Math.max(2, Math.ceil(words.length * 0.75));
        if (best?.exact || (words.length >= 2 && best?.matchedWords >= requiredWords)) {
          match = best.product;
          matchMethod = "name";
        }
      }
      const quantity = Number.isFinite(Number(recognized?.quantity)) ? Number(recognized.quantity) : null;
      const unitWeight = Number(match?.weight) || 0;
      return { id: match?.id ?? null, name: match?.full_name ?? recognized?.name ?? null, code: match?.product_code ?? recognized?.code ?? null, weight: unitWeight, quantity, quantityLabel: recognized?.quantityLabel ?? null, pallets: Number.isFinite(Number(recognized?.pallets)) ? Number(recognized.pallets) : null, palletType: recognized?.palletType ?? null, lineWeight: quantity == null ? 0 : unitWeight * quantity, matched: Boolean(match), matchMethod };
    });
    const estimatedWeight = Number.isFinite(Number(req.body?.recognizedWeight)) && Number(req.body.recognizedWeight) >= 0 ? Number(req.body.recognizedWeight) : 0;
    const result = await pool.query(
      `INSERT INTO public.transport_scan_items
       (session_token, address_id, pallets, recognized_text, recognized_client_name,
        recognized_address, recognized_city, recognized_postal_code, product_matches, estimated_weight)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING id, address_id, pallets, created_at, product_matches, estimated_weight`,
      [req.params.token, addressId, pallets, recognizedText,
       req.body?.recognizedClientName || null, req.body?.recognizedAddress || null,
       req.body?.recognizedCity || null, req.body?.recognizedPostalCode || null,
       JSON.stringify(productMatches), estimatedWeight],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add transport scan item error:", error);
    res.status(500).json({ error: "Failed to add scanned order" });
  }
}

export async function resolveScanSessionItem(req: Request, res: Response): Promise<void> {
  try {
    await ensureTransportScanTables();
    const addressId = Number(req.body?.addressId);
    const pallets = Number(req.body?.pallets);
    const estimatedWeight = Number(req.body?.estimatedWeight);
    if (!Number.isSafeInteger(addressId) || addressId < 1 || !Number.isSafeInteger(pallets) || pallets < 1 || pallets > 999 || !Number.isFinite(estimatedWeight) || estimatedWeight < 0) {
      res.status(400).json({ error: "A valid address, pallet count, and total weight are required" }); return;
    }
    const submittedProducts = Array.isArray(req.body?.productMatches) ? req.body.productMatches.slice(0, 100) : [];
    const productIds = submittedProducts.map((product: any) => Number(product?.id)).filter((id: number) => Number.isSafeInteger(id) && id > 0);
    const catalog = productIds.length ? await pool.query(`SELECT id, full_name, product_code, weight FROM public.finished_product WHERE id = ANY($1::int[]) AND is_active = true`, [productIds]) : { rows: [] as any[] };
    const catalogById = new Map(catalog.rows.map((product: any) => [Number(product.id), product]));
    if (submittedProducts.some((product: any) => !catalogById.has(Number(product?.id)))) {
      res.status(400).json({ error: "Chaque ligne reconnue doit être associée à un produit fini actif" }); return;
    }
    const correctedProducts = submittedProducts.map((line: any) => {
      const product: any = catalogById.get(Number(line.id));
      const quantity = Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : null;
      const weight = Number(product.weight) || 0;
      return { id: product.id, code: product.product_code, name: product.full_name, weight, quantity, quantityLabel: line.quantityLabel ?? null, pallets: Number.isFinite(Number(line.pallets)) ? Number(line.pallets) : null, palletType: line.palletType ?? null, lineWeight: quantity == null ? 0 : quantity * weight, matched: true };
    });
    const result = await pool.query(
      `UPDATE public.transport_scan_items i SET address_id = $4, pallets = $5, product_matches = $6::jsonb, estimated_weight = $7, confirmed = true
       FROM public.transport_scan_sessions s, sales.clients_addresses a
       WHERE i.id = $1 AND i.session_token = $2 AND s.token = i.session_token
         AND s.owner_user_id = $3 AND s.expires_at > NOW() AND a.id = $4
       RETURNING i.id, i.address_id, i.pallets, i.confirmed`,
      [Number(req.params.itemId), req.params.token, req.user!.id, addressId, pallets, JSON.stringify(correctedProducts), estimatedWeight],
    );
    if (!result.rows.length) { res.status(404).json({ error: "Scan item or address not found" }); return; }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Resolve transport scan item error:", error);
    res.status(500).json({ error: "Failed to resolve scanned order" });
  }
}

export async function deleteScanSessionItem(req: Request, res: Response): Promise<void> {
  try {
    await ensureTransportScanTables();
    const result = await pool.query(
      `DELETE FROM public.transport_scan_items i
       USING public.transport_scan_sessions s
       WHERE i.id = $1 AND i.session_token = $2 AND s.token = i.session_token
         AND s.owner_user_id = $3 AND s.expires_at > NOW() AND i.confirmed = false
       RETURNING i.id`,
      [Number(req.params.itemId), req.params.token, req.user!.id],
    );
    if (!result.rows.length) { res.status(404).json({ error: "Pending scanned order not found" }); return; }
    res.status(204).send();
  } catch (error) {
    console.error("Delete transport scan item error:", error);
    res.status(500).json({ error: "Failed to dismiss scanned order" });
  }
}

export async function optimizeRoute(
  req: Request<{}, {}, OptimizeRouteBody>,
  res: Response
): Promise<void> {
  try {
    const { locations } = req.body;

    if (!Array.isArray(locations) || locations.length < 2) {
      res.status(400).json({
        error: "At least 2 locations are required",
      });

      return;
    }

    const matrixResult = await getRouteMatrix(locations);

    const optimization = optimizeRoundTrip(
      matrixResult.durations
    );

    const orderedLocations = optimization.route.map(
      (index) => locations[index]
    );

    const legs = [];

    for (let i = 0; i < optimization.route.length - 1; i++) {
      const fromIndex = optimization.route[i];
      const toIndex = optimization.route[i + 1];

      const duration =
        matrixResult.durations[fromIndex]?.[toIndex];

      const distance =
        matrixResult.distances[fromIndex]?.[toIndex];

      if (duration == null || distance == null) {
        continue;
      }

      legs.push({
        from: locations[fromIndex],
        to: locations[toIndex],

        durationSeconds: duration,
        durationMinutes: Math.round(duration / 60),

        distanceMeters: distance,
        distanceKm: Math.round(distance / 100) / 10,
      });
    }

    res.json({
      route: orderedLocations,
      routeIndexes: optimization.route,
      legs,

      totalDurationSeconds:
        optimization.totalDuration,

      totalDurationMinutes:
        Math.round(optimization.totalDuration / 60),

      durations: matrixResult.durations,
      distances: matrixResult.distances,
    });
  } catch (error: unknown) {
    console.error("Route optimization error:", error);

    const message =
      error instanceof Error
        ? error.message
        : "Unknown error";

    res.status(500).json({
      error: "Failed to optimize route",
      details: message,
    });
  }
}

export async function getClientStops(_req: Request, res: Response): Promise<void> {
  try {
    const result = await pool.query(`
      SELECT a.id, a.client_id, c.name AS client_name, a.site_number, a.site_name,
        a.address, a.city, a.postal_code, a.province, a.country,
        a.latitude, a.longitude, a.delivery_region_id,
        dr.name AS delivery_region_name, dr.position_order AS delivery_region_position_order
      FROM sales.clients_addresses a
      JOIN sales.clients c ON c.id = a.client_id
      LEFT JOIN sales.delivery_regions dr ON dr.id = a.delivery_region_id
      WHERE a.address IS NOT NULL OR a.city IS NOT NULL OR a.postal_code IS NOT NULL
      ORDER BY dr.position_order NULLS LAST, lower(dr.name) NULLS LAST, lower(c.name), a.site_number NULLS LAST, a.id
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("Transport client stops error:", error);
    res.status(500).json({ error: "Failed to load client stops" });
  }
}

export async function resolveClientLocations(req: Request, res: Response): Promise<void> {
  try {
    const addressIds = Array.isArray(req.body?.addressIds)
      ? [...new Set(req.body.addressIds.map(Number).filter((id: number) => Number.isSafeInteger(id) && id > 0))]
      : [];
    if (!addressIds.length || addressIds.length > 8) {
      res.status(400).json({ error: "Select between 1 and 8 client addresses" });
      return;
    }
    const result = await pool.query(`
      SELECT a.id, c.name AS client_name, a.site_number, a.site_name,
        a.address, a.city, a.postal_code, a.province, a.country,
        a.latitude, a.longitude
      FROM sales.clients_addresses a
      JOIN sales.clients c ON c.id = a.client_id
      WHERE a.id = ANY($1::int[])
    `, [addressIds]);
    if (result.rows.length !== addressIds.length) {
      res.status(404).json({ error: "One or more client addresses were not found" });
      return;
    }
    const locations = [];
    let geocodedAddress = false;
    for (const addressId of addressIds) {
      const address = result.rows.find((row) => Number(row.id) === addressId);
      if (address.latitude == null || address.longitude == null) {
        if (geocodedAddress) await new Promise((resolve) => setTimeout(resolve, 1_100));
        const coordinates = await geocodeAddress(address);
        if (!coordinates) {
          res.status(422).json({ error: `Unable to geolocate ${address.client_name}` });
          return;
        }
        address.latitude = coordinates.latitude;
        address.longitude = coordinates.longitude;
        geocodedAddress = true;
        await pool.query(
          `UPDATE sales.clients_addresses SET latitude = $2, longitude = $3 WHERE id = $1`,
          [address.id, coordinates.latitude, coordinates.longitude],
        );
      }
      const site = [address.site_name, address.site_number != null ? `site ${address.site_number}` : null]
        .filter(Boolean).join(" — ");
      locations.push({
        id: address.id,
        name: [address.client_name, site || address.city].filter(Boolean).join(" — "),
        lat: Number(address.latitude),
        lng: Number(address.longitude),
      });
    }
    res.json(locations);
  } catch (error) {
    console.error("Resolve client locations error:", error);
    res.status(500).json({ error: "Failed to resolve client locations" });
  }
}

export async function getTransportOrders(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const result = await pool.query(`
      SELECT
        o.id,
        o.order_reference,
        o.trip_number,
        o.client_name,
        o.loaded_date,
        o.status,
        a.id AS address_id,
        a.site_number,
        a.site_name,
        a.address,
        a.city,
        a.postal_code,
        a.province,
        a.country,
        a.latitude,
        a.longitude,
        a.delivery_region_id,
        dr.name AS delivery_region_name,
        dr.position_order AS delivery_region_position_order,
        COALESCE(SUM(i.quantity_ordered * fp.weight), 0) AS estimated_weight,
        COALESCE(SUM(i.actual_pallets), 0) AS actual_pallets
      FROM sales.orders o
      JOIN sales.clients_addresses a ON a.id = o.client_address_id
      LEFT JOIN sales.delivery_regions dr ON dr.id = a.delivery_region_id
      LEFT JOIN sales.order_items i ON i.order_id = o.id
      LEFT JOIN public.finished_product fp ON fp.id = i.finished_product_id
      WHERE o.status IN ('a-faire', 'en-cours')
      GROUP BY o.id, a.id, dr.id
      ORDER BY dr.position_order NULLS LAST, lower(dr.name) NULLS LAST, o.loaded_date, o.trip_number, o.id
    `);
    let geocodedAddress = false;
    for (const order of result.rows) {
      if (order.latitude != null && order.longitude != null) continue;
      if (geocodedAddress) await new Promise((resolve) => setTimeout(resolve, 1_100));
      const coordinates = await geocodeAddress(order);
      if (!coordinates) continue;
      geocodedAddress = true;
      order.latitude = coordinates.latitude;
      order.longitude = coordinates.longitude;
      await pool.query(
        `UPDATE sales.clients_addresses SET latitude = $2, longitude = $3 WHERE id = $1`,
        [order.address_id, coordinates.latitude, coordinates.longitude],
      );
    }
    res.json(result.rows);
  } catch (error) {
    console.error("Transport orders error:", error);
    res.status(500).json({ error: "Failed to load transport orders" });
  }
}
