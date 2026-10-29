/** Cut-relative effects. Exact sung word timestamps are not yet available. */
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

/** Percent revealed. The pencil moves for at most 3 seconds, then holds. */
export function handwritingProgress(startMs: number, endMs: number, playheadMs: number): number {
  const revealMs = Math.max(100, Math.min(3000, Math.round((endMs - startMs) * 0.8)));
  return 100 * Math.max(0, Math.min(1, (playheadMs - startMs) / revealMs));
}
