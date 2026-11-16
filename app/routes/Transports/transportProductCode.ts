type CatalogProduct = {
  product_code: unknown;
  full_name?: unknown;
};

export type ProductCodeResolution<T extends CatalogProduct> = {
  product: T | null;
  corrected: boolean;
};

export function normalizeProductCode(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function resolveProductCode<T extends CatalogProduct>(
  recognizedCode: unknown,
  recognizedName: unknown,
  productsByCode: Map<string, T>,
): ProductCodeResolution<T> {
  const code = normalizeProductCode(recognizedCode);
  if (!code) return { product: null, corrected: false };

  const exact = productsByCode.get(code) ?? null;
  const alternatives = eightToSixVariants(code)
    .map((candidateCode) => productsByCode.get(candidateCode) ?? null)
    .filter((product): product is T => product !== null);

  if (alternatives.length === 0) {
    return { product: exact, corrected: false };
  }

  const uniqueAlternatives = [
    ...new Map(
      alternatives.map((product) => [normalizeProductCode(product.product_code), product]),
    ).values(),
  ];

  if (!exact && uniqueAlternatives.length === 1) {
    return { product: uniqueAlternatives[0], corrected: true };
  }

  const recognizedWords = normalizedWords(recognizedName);
  if (recognizedWords.length < 2) {
    return { product: exact, corrected: false };
  }

  const candidates = exact
    ? [exact, ...uniqueAlternatives]
    : uniqueAlternatives;
  const ranked = candidates
    .map((product) => ({
      product,
      score: nameSimilarity(recognizedWords, product.full_name),
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const second = ranked[1];
  const exactScore = exact
    ? nameSimilarity(recognizedWords, exact.full_name)
    : 0;
  const confidentlyMatchesName =
    best.score >= 0.75 && best.score - (second?.score ?? 0) >= 0.25;
  const overridesExactCode =
    exact !== null && best.product !== exact && exactScore <= 0.25;

  if (
    confidentlyMatchesName &&
    (!exact || overridesExactCode)
  ) {
    return {
      product: best.product,
      corrected: normalizeProductCode(best.product.product_code) !== code,
    };
  }

  return { product: exact, corrected: false };
}

function eightToSixVariants(code: string): string[] {
  if (!/^\d+$/.test(code)) return [];
  const positions = [...code]
    .map((character, index) => (character === "8" ? index : -1))
    .filter((index) => index >= 0);
  if (positions.length === 0 || positions.length > 8) return [];

  const variants = new Set<string>();
  for (let mask = 1; mask < 2 ** positions.length; mask += 1) {
    const characters = [...code];
    positions.forEach((position, bit) => {
      if (mask & (1 << bit)) characters[position] = "6";
    });
    variants.add(characters.join(""));
  }
  return [...variants];
}

function normalizedWords(value: unknown): string[] {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

function nameSimilarity(
  recognizedWords: string[],
  catalogName: unknown,
): number {
  const catalogWords = new Set(normalizedWords(catalogName));
  if (catalogWords.size === 0) return 0;
  const matches = recognizedWords.filter((word) => catalogWords.has(word)).length;
  return matches / recognizedWords.length;
}
