type RecognizedTransportProduct = {
  code: string | null;
  lotNumber: string | null;
  name: string | null;
  quantityLabel: string | null;
  quantity: number | null;
  pallets: number | null;
  palletType: string | null;
  unit: string | null;
};

export type NormalizedTransportDocumentAnalysis = {
  clientName: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  customerPo: string | null;
  loadedDate: unknown;
  pallets: number | null;
  totalWeight: number | null;
  rawText: string;
  products: RecognizedTransportProduct[];
};

export function parseTransportDecimal(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const compact = value
    .trim()
    .replace(/[\s\u00a0\u202f']/g, "");
  const numericToken = compact.match(/[-+]?\d[\d.,]*/)?.[0];
  if (!numericToken) return null;

  const commaCount = (numericToken.match(/,/g) ?? []).length;
  const dotCount = (numericToken.match(/\./g) ?? []).length;
  let normalized = numericToken;

  if (commaCount && dotCount) {
    const decimalSeparator =
      numericToken.lastIndexOf(",") > numericToken.lastIndexOf(".")
        ? ","
        : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    normalized = numericToken
      .replaceAll(groupingSeparator, "")
      .replace(decimalSeparator, ".");
  } else if (commaCount === 1) {
    normalized = numericToken.replace(",", ".");
  } else if (commaCount > 1) {
    normalized = numericToken.replaceAll(",", "");
  } else if (dotCount > 1) {
    normalized = numericToken.replaceAll(".", "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseTransportQuantity(value: unknown): number | null {
  if (typeof value === "string") {
    const multiplication = value.match(
      /([-+]?\d[\d\s\u00a0\u202f'.,]*)\s*[x×]\s*([-+]?\d[\d\s\u00a0\u202f'.,]*)/i,
    );
    if (multiplication) {
      const pallets = parseTransportDecimal(multiplication[1]);
      const quantityPerPallet = parseTransportDecimal(multiplication[2]);
      if (pallets != null && quantityPerPallet != null) {
        return pallets * quantityPerPallet;
      }
    }
  }
  return parseTransportDecimal(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = parseTransportDecimal(value);
  return parsed != null && Number.isSafeInteger(parsed) ? parsed : null;
}

export function normalizeTransportDocumentAnalysis(
  parsed: any,
  rawTextFallback = "",
): NormalizedTransportDocumentAnalysis {
  const rawText =
    typeof parsed?.rawText === "string" ? parsed.rawText : rawTextFallback;

  return {
    clientName: textOrNull(parsed?.clientName),
    address: textOrNull(parsed?.address),
    city: textOrNull(parsed?.city),
    province: textOrNull(parsed?.province),
    postalCode: textOrNull(parsed?.postalCode),
    customerPo: textOrNull(parsed?.customerPo),
    loadedDate: parsed?.loadedDate ?? null,
    pallets: integerOrNull(parsed?.pallets),
    totalWeight: parseTransportDecimal(parsed?.totalWeight),
    rawText,
    products: Array.isArray(parsed?.products)
      ? parsed.products.slice(0, 100).map((product: any) => ({
          code: textOrNull(product?.code),
          lotNumber: textOrNull(product?.lotNumber),
          name: textOrNull(product?.name),
          quantityLabel: textOrNull(product?.quantityLabel),
          quantity: parseTransportQuantity(product?.quantity),
          pallets: parseTransportDecimal(product?.pallets),
          palletType: textOrNull(product?.palletType),
          unit: textOrNull(product?.unit),
        }))
      : [],
  };
}
