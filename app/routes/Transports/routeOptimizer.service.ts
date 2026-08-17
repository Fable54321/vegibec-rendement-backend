export interface RouteOptimizationResult {
  route: number[];
  totalDuration: number;
}

function permutations<T>(array: T[]): T[][] {
  if (array.length <= 1) {
    return [array];
  }

  const result: T[][] = [];

  for (let i = 0; i < array.length; i++) {
    const current = array[i];

    const remaining = [
      ...array.slice(0, i),
      ...array.slice(i + 1),
    ];

    const remainingPermutations = permutations(remaining);

    for (const permutation of remainingPermutations) {
      result.push([current, ...permutation]);
    }
  }

  return result;
}

export function optimizeRoundTrip(
  matrix: Array<Array<number | null>>
): RouteOptimizationResult {
  if (!matrix || matrix.length < 2) {
    throw new Error("Invalid duration matrix");
  }

  const destinationIndexes: number[] = [];

  for (let i = 1; i < matrix.length; i++) {
    destinationIndexes.push(i);
  }

  const possibleRoutes = permutations(destinationIndexes);

  let bestRoute: number[] | null = null;
  let bestDuration = Infinity;

  for (const route of possibleRoutes) {
    const fullRoute = [0, ...route, 0];

    let totalDuration = 0;
    let valid = true;

    for (let i = 0; i < fullRoute.length - 1; i++) {
      const from = fullRoute[i];
      const to = fullRoute[i + 1];

      const duration = matrix[from]?.[to];

      if (duration == null) {
        valid = false;
        break;
      }

      totalDuration += duration;
    }

    if (valid && totalDuration < bestDuration) {
      bestDuration = totalDuration;
      bestRoute = fullRoute;
    }
  }

  if (!bestRoute) {
    throw new Error("No valid route could be found");
  }

  return {
    route: bestRoute,
    totalDuration: bestDuration,
  };
}