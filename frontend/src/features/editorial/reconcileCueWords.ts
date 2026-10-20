import type { WordTiming } from "../../lib/api.types";

export type WordReconciliation = {
  words: WordTiming[];
  suggestedEndMs?: number;
  insertedCount?: number;
  error?: string;
};

/**
 * Preview human text edits against ASR words. Deleted tokens disappear
 * immediately; surviving tokens keep their ID, timestamps and translations.
 * New words get provisional, mathematically estimated timings. They are
 * never treated as observed speech until the editor reviews them.
 */
function syllables(surface: string): number {
  return Math.max(1, surface.toLowerCase().match(/[aeiouy]+/g)?.length ?? 0);
}

function estimatedWordDuration(surface: string, words: WordTiming[]): number {
  const samples = words
    .filter((word) => word.end_ms > word.start_ms)
    .map((word) => (word.end_ms - word.start_ms) / syllables(word.surface))
    .sort((a, b) => a - b);
  const pace = Math.max(135, Math.min(360, samples[Math.floor(samples.length / 2)] ?? 220));
  return Math.max(130, Math.min(950, Math.round(pace * syllables(surface))));
}

export function reconcileCueWords(
  text: string,
  words: WordTiming[],
  cueStartMs = words[0]?.start_ms ?? 0,
): WordReconciliation {
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

  const matches = new Map<number, WordTiming | null>();
  let oldPosition = 0;
  let newPosition = 0;
  for (const [oldEnd, newEnd] of [...anchors, [n, m] as [number, number]]) {
    const oldCount = oldEnd - oldPosition;
    const newCount = newEnd - newPosition;
    for (let offset = 0; offset < newCount; offset += 1) {
      matches.set(newPosition + offset, offset < oldCount ? words[oldPosition + offset] : null);
    }
    if (oldEnd < n) matches.set(newEnd, words[oldEnd]);
    oldPosition = oldEnd + 1;
    newPosition = newEnd + 1;
  }

  if (matches.size !== m) return { words, error: "Não foi possível identificar as palavras." };
  let cursor = cueStartMs;
  let insertedCount = 0;
  const updated: WordTiming[] = tokens.map((surface, index) => {
    const previous = matches.get(index);
    if (!previous) {
      insertedCount += 1;
      const start_ms = cursor + (index > 0 ? 15 : 0);
      const end_ms = start_ms + estimatedWordDuration(surface, words);
      cursor = end_ms;
      return {
        id: `editorial-new-${index}`,
        order: index + 1,
        surface,
        start_ms,
        end_ms,
        pt: "",
        provenance: {
          pt: "",
          editorial_word_inserted: true,
          editorial_timing_estimated: true,
          translation_review_required: true,
        },
      };
    }
    const provenance = { ...previous.provenance };
    if (previous.surface !== surface) {
      provenance.editorial_word_edited = true;
      if (lexical(previous.surface) !== lexical(surface)) {
        provenance.translation_review_required = true;
      }
    }
    const start_ms = Math.max(previous.start_ms, cursor);
    const end_ms = start_ms + previous.end_ms - previous.start_ms;
    if (start_ms !== previous.start_ms) {
      delete provenance.word_timing_reviewed;
      delete provenance.word_timing_reviewed_by;
      provenance.editorial_timing_estimated = true;
    }
    cursor = end_ms;
    return { ...previous, order: index + 1, surface, start_ms, end_ms, provenance };
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
      const provenance: Record<string, unknown> = {
        ...word.provenance, translation_review_required: true,
      };
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
  const semanticGroups = new Set(
    updated.map((word) => word.semantic_group_id).filter((id): id is string => Boolean(id)),
  );
  for (const groupId of semanticGroups) {
    const positions = updated.flatMap((word, index) =>
      word.semantic_group_id === groupId ? [index] : [],
    );
    if (positions.every((position, rank) => position === positions[0] + rank)) continue;
    for (const index of positions) {
      const word = updated[index];
      const provenance = { ...word.provenance, translation_review_required: true };
      const pt = String(provenance.pt_original || word.pt || "");
      delete provenance.semantic_group_id;
      delete provenance.semantic_group_role;
      updated[index] = {
        ...word,
        pt,
        semantic_group_id: null,
        semantic_group_role: null,
        provenance: { ...provenance, pt },
      };
    }
  }
  return { words: updated, suggestedEndMs: cursor, insertedCount };
}
