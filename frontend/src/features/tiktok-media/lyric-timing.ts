/** A cut-relative, deterministic guide for progressive lyric highlighting. */
export function lyricWords(text: string, startMs: number, endMs: number, playheadMs: number) {
  const tokens = text.match(/\s*\S+\s*/gu) ?? [];
  const weights = tokens.map((token) => Math.max(1, Array.from(token.trim()).length));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const progress = Math.max(0, Math.min(1, (playheadMs - startMs) / Math.max(1, endMs - startMs)));
  let elapsedWeight = 0;
  return tokens.map((text, index) => {
    const start = elapsedWeight / totalWeight;
    elapsedWeight += weights[index];
    const end = elapsedWeight / totalWeight;
    return { text, state: progress >= end ? "done" : progress >= start ? "active" : "upcoming" };
  });
}
