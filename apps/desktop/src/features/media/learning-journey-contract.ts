/**
 * Learning Journey package shared by Nova Generator and iHubEnglish.
 *
 * Nova Generator authors and validates this package. iHubEnglish consumes
 * the published package and owns learner-specific progress.
 */
export const LEARNING_JOURNEY_CONTRACT = "nova-generator-learning-journey/1.0" as const;
export const IHUB_JOURNEY_CONTRACT = "ihub-learning-journey/1.0" as const;

export type ListeningQuestion =
  | { id: string; type: "identify"; prompt: string; audioCueIds: string[]; options: { id: string; text: string }[]; answerId: string }
  | { id: string; type: "gap"; prompt: string; audioCueIds: string[]; sentence: string; acceptedAnswers: string[]; hint?: string }
  | { id: string; type: "detail"; prompt: string; audioCueIds: string[]; options: { id: string; text: string }[]; answerId: string }
  | { id: string; type: "word-recognition"; prompt: string; audioCueIds: string[]; options: { id: string; text: string }[]; answerId: string }
  | { id: string; type: "reconstruct"; prompt: string; audioCueIds: string[]; words: string[]; answer: string[] };

export type MicroLesson = {
  id: string;
  title: string;
  focus: "expression" | "grammar" | "connected-speech" | "pronunciation" | "pragmatics";
  sourceCueIds: string[];
  targetEn: string;
  targetPt: string;
  explanationPt: string;
  examples: { en: string; pt: string }[];
  practice: {
    prompt: string;
    options: { id: string; text: string }[];
    answerId: string;
    feedbackPt: string;
  };
};

export type DeepListeningTask = {
  id: string;
  cueIds: string[];
  mode: "no-subtitles" | "gap-fill" | "connected-speech" | "rhythm";
  prompt: string;
  expectedText?: string;
  acceptedAnswers?: string[];
  explanationPt?: string;
};

export type SpeakingPrompt = {
  id: string;
  cueIds: string[];
  sourceText: string;
  translationPt?: string;
  focus: "rhythm" | "pauses" | "connected-speech" | "intonation" | "fluency";
};

export type LearningJourneyPackage = {
  contract: typeof LEARNING_JOURNEY_CONTRACT;
  version: 1;
  source: { projectId: string; assetId: string; sourceSignature: string };
  language: { source: "en"; support: "pt-BR" };
  days: [
    { day: 1; title: "Explore & Understand"; mode: "existing-stages"; stageKeys: ["english", "word", "shadowing", "audio", "practice"] },
    { day: 2; title: "Listening Recall"; mode: "listening-recall"; activities: ListeningQuestion[] },
    { day: 3; title: "Notice in Context"; mode: "micro-lessons"; lessons: MicroLesson[] },
    { day: 4; title: "Deep Listening"; mode: "deep-listening"; tasks: DeepListeningTask[] },
    { day: 5; title: "Speak & Compare"; mode: "speaking"; prompts: SpeakingPrompt[] },
    { day: 6; title: "Listening & Speaking Challenge"; mode: "mixed-challenge"; listening: ListeningQuestion[]; speaking: SpeakingPrompt[] },
    { day: 7; title: "Final Challenge"; mode: "final-challenge"; listening: ListeningQuestion[]; speaking: SpeakingPrompt[]; successCriteria: string[] }
  ];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function validateLearningJourney(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["O pacote precisa ser um objeto JSON."];
  if (value.contract !== LEARNING_JOURNEY_CONTRACT) errors.push("Contrato incompatível.");
  if (value.version !== 1) errors.push("Versão do pacote não suportada.");
  if (!isRecord(value.source) || !nonEmpty(value.source.projectId) ||
      !nonEmpty(value.source.assetId) || !nonEmpty(value.source.sourceSignature)) {
    errors.push("Identificação da mídia de origem incompleta.");
  }
  if (!Array.isArray(value.days) || value.days.length !== 7) {
    errors.push("A jornada precisa conter exatamente sete dias.");
    return errors;
  }
  const expectedModes = [
    "existing-stages", "listening-recall", "micro-lessons", "deep-listening",
    "speaking", "mixed-challenge", "final-challenge"
  ];
  value.days.forEach((day, index) => {
    if (!isRecord(day) || day.day !== index + 1 || day.mode !== expectedModes[index]) {
      errors.push("Estrutura inválida no Dia " + (index + 1) + ".");
    }
  });
  const day2 = value.days[1];
  if (isRecord(day2) && (!Array.isArray(day2.activities) || day2.activities.length < 3)) {
    errors.push("O Dia 2 precisa de pelo menos três exercícios reais de listening.");
  }
  const day3 = value.days[2];
  if (isRecord(day3) && (!Array.isArray(day3.lessons) || day3.lessons.length === 0)) {
    errors.push("O Dia 3 precisa de ao menos uma microaula criada no Nova Generator.");
  }
  const day5 = value.days[4];
  if (isRecord(day5) && (!Array.isArray(day5.prompts) || day5.prompts.length === 0)) {
    errors.push("O Dia 5 precisa de ao menos uma atividade de speaking.");
  }
  return errors;
}


export type JourneySourceCue = { id: string; text: string; startMs: number; endMs: number };
export type JourneySourceCard = {
  id: string; sourceCueId: string; focus: string; meaning: string;
  highlightEn: string; explanation: string; exampleEn: string; examplePt: string;
  status: "draft" | "approved";
};

const wordsOf = (sentence: string) => sentence.match(/[A-Za-z']+/g) ?? [];
const unique = <T,>(items: T[]) => Array.from(new Set(items));

/** Creates an editable first draft from reviewed transcript cues and approved cards. */
export function buildLearningJourneyPackage(input: {
  projectId: string;
  assetId: string;
  sourceSignature: string;
  cues: JourneySourceCue[];
  cards: JourneySourceCard[];
}): LearningJourneyPackage {
  const cues = input.cues.filter(cue => cue.id && cue.text.trim() && cue.endMs > cue.startMs);
  if (cues.length < 3) throw new Error("A jornada precisa de pelo menos três trechos válidos de transcrição.");
  const approvedCards = input.cards.filter(card => card.status === "approved" && card.focus.trim() && card.meaning.trim());
  const selected = cues.slice(0, 12);
  const distractors = (cue: JourneySourceCue) => unique(
    cues.filter(item => item.id !== cue.id).map(item => item.text.trim())
  ).slice(0, 2);
  const listening: ListeningQuestion[] = selected.slice(0, 6).map((cue, index) => {
    const alternatives = distractors(cue);
    return {
      id: "recall-identify-" + cue.id,
      type: "identify",
      prompt: "Which sentence did you hear?",
      audioCueIds: [cue.id],
      options: [{ id: "correct", text: cue.text }, ...alternatives.map((text, i) => ({ id: "distractor-" + i, text }))],
      answerId: "correct"
    };
  });
  selected.slice(0, 6).forEach(cue => {
    const tokens = wordsOf(cue.text);
    if (tokens.length >= 4) {
      const target = tokens[Math.min(tokens.length - 2, Math.max(1, Math.floor(tokens.length / 2)))];
      listening.push({
        id: "recall-gap-" + cue.id,
        type: "gap",
        prompt: "Listen and complete the missing word.",
        audioCueIds: [cue.id],
        sentence: cue.text.replace(new RegExp("\\b" + target.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&") + "\\b", "i"), "_____"),
        acceptedAnswers: [target]
      });
    }
  });
  const lessons: MicroLesson[] = approvedCards.slice(0, 12).map(card => ({
    id: "micro-" + card.id,
    title: card.highlightEn || card.focus,
    focus: /\b(?:am|is|are|was|were|do|does|did|have|has|had)\b/i.test(card.focus) ? "grammar" : "expression",
    sourceCueIds: card.sourceCueId ? [card.sourceCueId] : [],
    targetEn: card.highlightEn || card.focus,
    targetPt: card.meaning,
    explanationPt: card.explanation || "Observe como esta expressão funciona no contexto original.",
    examples: card.exampleEn ? [{ en: card.exampleEn, pt: card.examplePt }] : [],
    practice: {
      prompt: "Qual alternativa mantém o sentido da expressão no contexto?",
      options: [{ id: "context", text: card.meaning }, { id: "literal", text: "Uma tradução palavra por palavra, sem considerar o contexto." }],
      answerId: "context",
      feedbackPt: "A resposta considera o significado contextual da expressão."
    }
  }));
  const deepTasks: DeepListeningTask[] = selected.slice(0, 8).map((cue, index) => ({
    id: "deep-" + cue.id,
    cueIds: [cue.id],
    mode: index % 3 === 0 ? "no-subtitles" : index % 3 === 1 ? "gap-fill" : "connected-speech",
    prompt: index % 3 === 0 ? "Ouça sem legendas e identifique a ideia principal." : index % 3 === 1 ? "Ouça novamente e complete a frase." : "Observe como as palavras se conectam na fala.",
    expectedText: cue.text,
    acceptedAnswers: [cue.text]
  }));
  const speaking: SpeakingPrompt[] = selected.slice(0, 8).map((cue, index) => ({
    id: "speak-" + cue.id,
    cueIds: [cue.id],
    sourceText: cue.text,
    focus: (["rhythm", "pauses", "connected-speech", "intonation"] as const)[index % 4]
  }));
  const day2Activities = listening.slice(0, Math.max(3, Math.min(10, listening.length)));
  const mixedListening = listening.slice(0, 4);
  const mixedSpeaking = speaking.slice(0, 3);
  return {
    contract: LEARNING_JOURNEY_CONTRACT,
    version: 1,
    source: { projectId: input.projectId, assetId: input.assetId, sourceSignature: input.sourceSignature },
    language: { source: "en", support: "pt-BR" },
    days: [
      { day: 1, title: "Explore & Understand", mode: "existing-stages", stageKeys: ["english", "word", "shadowing", "audio", "practice"] },
      { day: 2, title: "Listening Recall", mode: "listening-recall", activities: day2Activities },
      { day: 3, title: "Notice in Context", mode: "micro-lessons", lessons },
      { day: 4, title: "Deep Listening", mode: "deep-listening", tasks: deepTasks },
      { day: 5, title: "Speak & Compare", mode: "speaking", prompts: speaking },
      { day: 6, title: "Listening & Speaking Challenge", mode: "mixed-challenge", listening: mixedListening, speaking: mixedSpeaking },
      { day: 7, title: "Final Challenge", mode: "final-challenge", listening: listening.slice(0, 5), speaking: speaking.slice(0, 4), successCriteria: ["Compreender as falas sem depender das legendas.", "Reconhecer expressões estudadas em contexto.", "Reproduzir trechos com ritmo e entonação compreensíveis."] }
    ]
  };
}
