export function readVertex(index, target, positionsArray) {
  const offset = index * 3;
  target.set(
    positionsArray[offset],
    positionsArray[offset + 1],
    positionsArray[offset + 2],
  );
  return target;
}

export function barycentricToVector(bary, a, b, c, target) {
  target.set(0, 0, 0);
  target.addScaledVector(a, bary.a);
  target.addScaledVector(b, bary.b);
  target.addScaledVector(c, bary.c);
  return target;
}

export function normalizeBarycentric(bary) {
  const sum = bary.a + bary.b + bary.c;
  if (sum === 0) {
    return { a: 1 / 3, b: 1 / 3, c: 1 / 3 };
  }
  return {
    a: bary.a / sum,
    b: bary.b / sum,
    c: bary.c / sum,
  };
}
