import type { MotionGraphic } from "./model";

/** Builds the ordered rendering view without changing the two persisted source collections. */
export function mergeMotionLayers(
  textLayers: MotionGraphic[],
  captions: MotionGraphic[],
  order: string[],
): MotionGraphic[] {
  const byId = new Map([...textLayers, ...captions].map(item => [item.id, item]));
  const result: MotionGraphic[] = [];
  const included = new Set<string>();

  // First honor the explicit layer order, ignoring stale and duplicate IDs.
  for (const id of order) {
    const item = byId.get(id);
    if (!item || included.has(id)) continue;
    result.push(item);
    included.add(id);
  }

  // Then append any item missing from the order list instead of dropping it.
  for (const item of [...textLayers, ...captions]) {
    if (included.has(item.id)) continue;
    result.push(item);
    included.add(item.id);
  }

  return result;
}

/** Separates the rendering view back into its independently persisted collections. */
export function splitMotionLayers(items: MotionGraphic[]): {
  textLayers: MotionGraphic[];
  captions: MotionGraphic[];
} {
  return {
    textLayers: items.filter(item => !item.isCaption),
    captions: items.filter(item => !!item.isCaption),
  };
}
