import type { WordTiming } from "../../lib/api.types";

export type WordReconciliation = {
  words: WordTiming[];
  error?: string;
};

/**
 * Preview human text edits against ASR words. Deleted tokens disappear
 * immediately; surviving tokens keep their ID, timestamps and translations.
 * New words require explicit timing, never made-up timestamps.
 */
export function reconcileCueWords(text: string, words: WordTiming[]): WordReconciliation {
  const tokens = text.match(/\s*\S+/g) ?? [];
  if (!tokens.length) return { words: [], error: "A cue precisa conter palavras." };
  if (text.slice(tokens.join("").length).trim())
    return { words, error: "O texto contém separação de palavras inválida." };

  const lexical = (value: string) => value.replace(/[^\p{L}\p{N}_]+/gu, "").toLowerCase();
  const old = words.map((word) => lexical(word.surface));
  const next = tokens.map(lexical);
  const n = old.length;
  const m = next.length;
  const lcs = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        old[i] === next[j]
          ? 1 + lcs[i + 1][j + 1]
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const anchors: Array<[number, number]> = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < n && newIndex < m) {
    if (old[oldIndex] === next[newIndex]) {
      anchors.push([oldIndex, newIndex]);
      oldIndex += 1;
      newIndex += 1;
    } else if (lcs[oldIndex + 1][newIndex] >= lcs[oldIndex][newIndex + 1]) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }

  const matches = new Map<number, WordTiming>();
  let oldPosition = 0;
  let newPosition = 0;
  for (const [oldEnd, newEnd] of [...anchors, [n, m] as [number, number]]) {
    const oldCount = oldEnd - oldPosition;
    const newCount = newEnd - newPosition;
    if (newCount > oldCount) {
      return {
        words,
        error: "Uma palavra nova precisa de tempos IN/OUT próprios. Corrija a segmentação antes de salvar.",
      };
    }
    for (let offset = 0; offset < newCount; offset += 1) {
      matches.set(newPosition + offset, words[oldPosition + offset]);
    }
    if (oldEnd < n) matches.set(newEnd, words[oldEnd]);
    oldPosition = oldEnd + 1;
    newPosition = newEnd + 1;
  }

  if (matches.size !== m) return { words, error: "Não foi possível identificar as palavras." };
  const updated = tokens.map((surface, index) => {
    const previous = matches.get(index)!;
    const provenance = { ...previous.provenance };
    if (previous.surface !== surface) {
      provenance.editorial_word_edited = true;
      if (lexical(previous.surface) !== lexical(surface)) {
        provenance.translation_review_required = true;
      }
    }
    return { ...previous, order: index + 1, surface, provenance };
  });

  const retained = new Set(updated.map((word) => word.id));
  const removed = words.filter((word) => !retained.has(word.id));
  const affected = new Set(
    removed.map((word) => word.semantic_group_id).filter((id): id is string => Boolean(id)),
  );
  for (const groupId of affected) {
    const original = words.filter((word) => word.semantic_group_id === groupId);
    const indices = updated.flatMap((word, index) =>
      word.semantic_group_id === groupId ? [index] : [],
    );
    if (!indices.length) continue;
    const groupTranslation =
      original.find((word) => typeof word.pt === "string" && word.pt.trim())?.pt ?? "";
    indices.forEach((index, rank) => {
      const word = updated[index];
      const provenance = { ...word.provenance, translation_review_required: true };
      const pt = rank === 0
        ? String(provenance.pt_original || word.pt || groupTranslation)
        : null;
      if (indices.length === 1) {
        delete provenance.semantic_group_id;
        delete provenance.semantic_group_role;
        updated[index] = {
          ...word,
          semantic_group_id: null,
          semantic_group_role: null,
          pt,
          provenance: { ...provenance, pt },
        };
      } else {
        const semantic_group_role = rank === 0 ? "lead" : "member";
        updated[index] = {
          ...word,
          semantic_group_role,
          pt,
          provenance: { ...provenance, pt, semantic_group_role },
        };
      }
    });
  }
  return { words: updated };
}
