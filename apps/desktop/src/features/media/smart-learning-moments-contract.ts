export const SMART_LEARNING_MOMENTS_CONTRACT = "nova-generator-smart-learning-moments/1.0" as const;
export const SMART_LEARNING_SCORE_WEIGHTS = {
  transferability: 20,
  communicative_utility: 15,
  instructional_value: 15,
  scene_relevance: 15,
  comprehension_potential: 10,
  level_fit: 10,
  explanation_clarity: 10,
  retention: 5
} as const;

export type SmartLearningScore = keyof typeof SMART_LEARNING_SCORE_WEIGHTS;
export type SmartLearningNarrationSegment = {
  id: string;
  language: "pt" | "en";
  text: string;
  purpose: "opening" | "explanation" | "example" | "closing";
};
export type SmartLearningExample = { en: string; pt: string; context: string };
export type SmartLearningContextNode = {
  id: string;
  title: string;
  purpose: string;
  examples: SmartLearningExample[];
  children?: SmartLearningContextNode[];
};
export type SmartLearningCandidate = {
  id: string;
  rank: number;
  pedagogical_score: number;
  score_breakdown: Record<SmartLearningScore, number>;
  score_evidence: Record<SmartLearningScore, string>;
  recommendation_reason: string;
  category: string;
  level: string;
  source: { cue_id: string; cue_order: number; start_ms: number; end_ms: number; trigger_start_ms: number; trigger_end_ms: number; expression: string; excerpt_en: string; excerpt_pt: string };
  lesson: {
    title: string;
    meaning_pt: string;
    communicative_intent_pt: string;
    explanation_pt: string;
    examples: SmartLearningExample[];
    context_tree: SmartLearningContextNode[];
    narration: { segments: SmartLearningNarrationSegment[]; estimated_duration_seconds: number; voice_direction: string };
  };
  selected?: boolean;
  audio_assets?: Array<{ segment_id: string; language: string; audio_path: string; provider: "internal" | "elevenlabs" }>;
};
export type SmartLearningMomentsPackage = {
  contract: typeof SMART_LEARNING_MOMENTS_CONTRACT;
  source_hash: string;
  source_signature?: string;
  recommendation_status: "recommended" | "no_recommendation";
  selection_limit: 1;
  candidates: SmartLearningCandidate[];
  final_selection: string | null;
};

export type SmartLearningCue = { id: string; startMs: number; endMs: number; text: string; words?: { text: string; startMs: number; endMs: number }[] };
const scoreKeys = Object.keys(SMART_LEARNING_SCORE_WEIGHTS) as SmartLearningScore[];
export function validateSmartLearningMoments(
  value: unknown,
  sourceHash: string,
  cues: SmartLearningCue[]
): string[] {
  const errors: string[] = [];
  const pkg = value as SmartLearningMomentsPackage;
  if (!pkg || pkg.contract !== SMART_LEARNING_MOMENTS_CONTRACT) return ["Contrato Smart Learning Moments inválido."];
  if (pkg.source_hash !== sourceHash) errors.push("SOURCE_HASH não corresponde à transcrição e aos tempos atuais.");
  if (pkg.selection_limit !== 1) errors.push("O limite de seleção deve ser exatamente uma mini aula.");
  if (!["recommended", "no_recommendation"].includes(pkg.recommendation_status)) errors.push("recommendation_status inválido.");
  if (!Array.isArray(pkg.candidates) || pkg.candidates.length > 8) return [...errors, "A IA deve retornar de 1 a 8 candidatas, ou nenhuma quando não houver recomendação."];
  if (pkg.recommendation_status === "no_recommendation" && pkg.candidates.length) errors.push("Uma resposta sem recomendação não pode conter candidatas.");
  if (pkg.recommendation_status === "recommended" && !pkg.candidates.length) errors.push("Inclua candidatas ou marque no_recommendation.");
  const ids = new Set<string>();
  const alignedRange = (cue: SmartLearningCue | undefined, expression: string) => {
    if (!cue?.words?.length) return null;
    const normalize = (value: string) => value.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}']/gu, "");
    const target = expression.trim().split(/\s+/).map(normalize);
    for (let start = 0; start <= cue.words.length - target.length; start++) {
      const candidate = cue.words.slice(start, start + target.length);
      if (candidate.every((word, index) => normalize(word.text) === target[index])) return {
        start_ms: candidate[0].startMs, end_ms: candidate[candidate.length - 1].endMs
      };
    }
    return null;
  };
  const sorted = [...pkg.candidates].sort((a, b) => b.pedagogical_score - a.pedagogical_score);
  pkg.candidates.forEach((candidate, index) => {
    if (!candidate?.id || ids.has(candidate.id)) errors.push("Há ID de candidata ausente ou duplicado.");
    ids.add(candidate.id);
    if (candidate.rank !== index + 1) errors.push("O ranking precisa ser sequencial e ordenado pela pontuação.");
    if (candidate.rank !== sorted.findIndex(item => item.id === candidate.id) + 1) errors.push("A ordem das candidatas não corresponde à pontuação.");
    let total = 0;
    for (const key of scoreKeys) {
      const score = candidate.score_breakdown?.[key];
      const weight = SMART_LEARNING_SCORE_WEIGHTS[key];
      if (!Number.isFinite(score) || score < 0 || score > weight) errors.push("Pontuação inválida em " + key + " para " + candidate.id + ".");
      else total += score;
      if (!candidate.score_evidence?.[key]?.trim()) errors.push("Falta evidência para " + key + " em " + candidate.id + ".");
    }
    if (Math.round(total) !== candidate.pedagogical_score) errors.push("A pontuação total não corresponde à soma dos critérios em " + candidate.id + ".");
    if (candidate.pedagogical_score < 70) errors.push("Candidatas abaixo de 70 pontos devem ser descartadas pela IA.");
    const cue = cues.find(item => item.id === candidate.source?.cue_id);
    if (!cue || candidate.source.cue_order !== cues.findIndex(item => item.id === cue?.id) + 1 || candidate.source.start_ms !== cue.startMs || candidate.source.end_ms !== cue.endMs) errors.push("A candidata " + candidate.id + " não corresponde à cue e aos tempos originais.");
    const wordRange = alignedRange(cue, candidate.source?.expression ?? "");
    if (!candidate.source?.expression?.trim() || !candidate.source?.excerpt_en?.trim() || !cue?.text.includes(candidate.source.excerpt_en.trim()) || !candidate.source.excerpt_en.toLocaleLowerCase().includes(candidate.source.expression.toLocaleLowerCase())) errors.push("A expressão e o trecho de origem da candidata " + candidate.id + " não foram encontrados na transcrição.");
    if (!wordRange || candidate.source.trigger_start_ms !== wordRange.start_ms || candidate.source.trigger_end_ms !== wordRange.end_ms) errors.push("A candidata " + candidate.id + " precisa usar o timing exato das palavras alinhadas para disparar a pausa.");

    const lesson = candidate.lesson;
    if (![candidate.category, candidate.level, candidate.recommendation_reason, lesson?.title, lesson?.meaning_pt, lesson?.communicative_intent_pt, lesson?.explanation_pt].every(item => typeof item === "string" && item.trim())) errors.push("A mini aula " + candidate.id + " está incompleta.");
    if (!Array.isArray(lesson?.examples) || lesson.examples.length < 2 || lesson.examples.some(item => !item.context?.trim() || !item.en?.trim() || !item.pt?.trim())) errors.push("A mini aula " + candidate.id + " precisa de pelo menos dois exemplos contextualizados.");
    if (!Array.isArray(lesson?.context_tree) || lesson.context_tree.length < 2) errors.push("A mini aula " + candidate.id + " precisa de pelo menos dois ramos na árvore de contextos.");
    if (!Array.isArray(lesson?.narration?.segments) || lesson.narration.segments.length < 3 || lesson.narration.segments.some(item => !item.id?.trim() || !["pt", "en"].includes(item.language) || !item.text?.trim())) errors.push("O roteiro de narração da mini aula " + candidate.id + " está incompleto.");
    if (!Number.isFinite(lesson?.narration?.estimated_duration_seconds) || lesson.narration.estimated_duration_seconds < 20 || lesson.narration.estimated_duration_seconds > 90) errors.push("A duração da mini aula " + candidate.id + " deve ficar entre 20 e 90 segundos.");
  });
  if (pkg.final_selection && !ids.has(pkg.final_selection)) errors.push("A seleção final aponta para uma candidata inexistente.");
  if (pkg.candidates.filter(item => item.selected).length > 1) errors.push("Somente uma mini aula pode estar selecionada.");
  if (pkg.final_selection && pkg.candidates.filter(item => item.selected).length === 1 && !pkg.candidates.find(item => item.id === pkg.final_selection)?.selected) errors.push("A seleção marcada não corresponde a final_selection.");
  return [...new Set(errors)];
}

export function buildSmartLearningSource(projectId: string, assetId: string, sourceSignature: string, cues: SmartLearningCue[], translations: { id: string; text: string }[]) {
  return {
    contract: "nova-generator-smart-learning-input/1.0",
    project_id: projectId,
    asset_id: assetId,
    source_signature: sourceSignature,
    timing_unit: "milliseconds_from_asset_start",
    cues: cues.map((cue, index) => ({
      cue_order: index + 1,
      cue_id: cue.id,
      start_ms: cue.startMs,
      end_ms: cue.endMs,
      text_en: cue.text,
      text_pt: translations.find(item => item.id === cue.id)?.text ?? "",
      words: (cue.words ?? []).map(word => ({ text: word.text, start_ms: word.startMs, end_ms: word.endMs }))
    }))
  };
}
