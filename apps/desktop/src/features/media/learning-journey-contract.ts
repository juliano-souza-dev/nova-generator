/**
 * Learning Journey package shared by Nova Generator and iHubEnglish.
 *
 * Nova Generator authors and validates this package. iHubEnglish consumes
 * the published package and owns learner-specific progress.
 */
export const LEARNING_JOURNEY_CONTRACT = "nova-generator-learning-journey/1.0" as const;
export const IHUB_JOURNEY_CONTRACT = "ihub-learning-journey/1.0" as const;

export type ListeningQuestionMetadata = {
  explanationPt?: string;
  feedbackCorrectPt?: string;
  feedbackIncorrectPt?: string;
  difficulty?: "beginner" | "elementary" | "intermediate" | "upper-intermediate";
  score?: number;
  score_breakdown?: Record<string, number>;
  pedagogical_rationale?: string;
  status?: "draft" | "approved" | "rejected";
  include_in_hub?: boolean;
};
export type ListeningQuestion =
  | ({ id: string; type: "identify"; prompt: string; audioCueOrders: number[]; options: { id: string; text: string }[]; answerId: string } & ListeningQuestionMetadata)
  | ({ id: string; type: "gap"; prompt: string; audioCueOrders: number[]; sentence: string; acceptedAnswers: string[]; hint?: string } & ListeningQuestionMetadata)
  | ({ id: string; type: "detail"; prompt: string; audioCueOrders: number[]; options: { id: string; text: string }[]; answerId: string } & ListeningQuestionMetadata)
  | ({ id: string; type: "word-recognition"; prompt: string; audioCueOrders: number[]; options: { id: string; text: string }[]; answerId: string } & ListeningQuestionMetadata)
  | ({ id: string; type: "reconstruct"; prompt: string; audioCueOrders: number[]; words: string[]; answer: string[] } & ListeningQuestionMetadata);

export type MicroLesson = {
  id: string;
  title: string;
  focus: "expression" | "grammar" | "connected-speech" | "pronunciation" | "pragmatics";
  sourceCueOrders: number[];
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
  cueOrders: number[];
  mode: "no-subtitles" | "gap-fill" | "connected-speech" | "rhythm";
  prompt: string;
  expectedText?: string;
  sentence?: string;
  acceptedAnswers?: string[];
  explanationPt?: string;
};

export type SpeakingPrompt = {
  id: string;
  cueOrders: number[];
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
  if (isRecord(day2) && (!Array.isArray(day2.activities) || day2.activities.length < 4)) {
    errors.push("O Dia 2 precisa de ao menos uma atividade em cada uma das quatro modalidades de listening.");
  } else if (isRecord(day2) && Array.isArray(day2.activities)) {
    const requiredTypes = ["identify", "word-recognition", "gap", "reconstruct"];
    const availableTypes = new Set(day2.activities.filter(isRecord).map(activity => activity.type));
    if (requiredTypes.some(type => !availableTypes.has(type))) {
      errors.push("O Dia 2 precisa incluir identificação, reconhecimento auditivo, lacunas e reconstrução.");
    }
  }
  const day3 = value.days[2];
  if (isRecord(day3) && (!Array.isArray(day3.lessons) || day3.lessons.length === 0)) {
    errors.push("O Dia 3 precisa de ao menos uma microaula criada no Nova Generator.");
  }
  const day4 = value.days[3];
  if (isRecord(day4) && (!Array.isArray(day4.tasks) || day4.tasks.length === 0)) {
    errors.push("O Dia 4 precisa de ao menos uma tarefa de listening profundo.");
  }
  const day5 = value.days[4];
  if (isRecord(day5) && (!Array.isArray(day5.prompts) || day5.prompts.length === 0)) {
    errors.push("O Dia 5 precisa de ao menos uma atividade de speaking.");
  }
  const day6 = value.days[5];
  if (isRecord(day6) && (!Array.isArray(day6.listening) || !day6.listening.length || !Array.isArray(day6.speaking) || !day6.speaking.length)) {
    errors.push("O Dia 6 precisa combinar listening e speaking.");
  }
  const day7 = value.days[6];
  if (isRecord(day7) && (!Array.isArray(day7.listening) || !day7.listening.length || !Array.isArray(day7.speaking) || !day7.speaking.length)) {
    errors.push("O Dia 7 precisa combinar listening e speaking.");
  }
  return errors;
}


/** Validates a persisted authoring draft without requiring unfinished Days 3–7. */
export function validateLearningJourneyDraft(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["O rascunho da jornada precisa ser um objeto JSON."];
  if (value.contract !== LEARNING_JOURNEY_CONTRACT || value.version !== 1) {
    errors.push("Contrato ou versão do rascunho incompatível.");
  }
  if (!isRecord(value.source) || !nonEmpty(value.source.projectId) ||
      !nonEmpty(value.source.assetId) || !nonEmpty(value.source.sourceSignature)) {
    errors.push("Identificação da mídia de origem incompleta.");
  }
  if (!Array.isArray(value.days) || value.days.length !== 7) {
    errors.push("O rascunho precisa preservar a estrutura dos sete dias.");
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
  if (isRecord(day2) && Array.isArray(day2.activities) && day2.activities.length > 0) {
    const types = new Set(day2.activities.filter(isRecord).map(activity => activity.type));
    if (["identify", "word-recognition", "gap", "reconstruct"].some(type => !types.has(type))) {
      errors.push("O rascunho do Dia 2 precisa preservar as quatro modalidades de listening.");
    }
  }
  return errors;
}


export type JourneySourceCue = { id: string; text: string; startMs: number; endMs: number; order?: number };
export type JourneySourceCard = {
  id: string; sourceCueId: string; type: string; focus: string; meaning: string;
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
  const cueOrder = (cue: JourneySourceCue) => Number(cue.order) > 0 ? Number(cue.order) : cues.indexOf(cue) + 1;
  const distractors = (cue: JourneySourceCue) => unique(
    cues.filter(item => item.id !== cue.id).map(item => item.text.trim())
  ).slice(0, 2);
  const listening: ListeningQuestion[] = selected.slice(0, 6).map((cue, index) => {
    const alternatives = distractors(cue);
    return {
      id: "recall-identify-" + cue.id,
      type: "identify",
      prompt: "Which sentence did you hear?",
      audioCueOrders: [cueOrder(cue)],
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
        audioCueOrders: [cueOrder(cue)],
        sentence: (() => { const at = cue.text.toLowerCase().indexOf(target.toLowerCase()); return at < 0 ? cue.text : cue.text.slice(0, at) + "_____" + cue.text.slice(at + target.length); })(),
        acceptedAnswers: [target]
      });
    }
  });
  selected.slice(0, 5).forEach(cue => {
    const tokens = wordsOf(cue.text);
    const alternatives = cues.filter(item => item.id !== cue.id && wordsOf(item.text).length >= 4).slice(0, 2);
    if (tokens.length >= 4 && alternatives.length) {
      const splitAt = Math.max(2, Math.floor(tokens.length / 2));
      const prefix = tokens.slice(0, splitAt).join(" ");
      const correctDetail = tokens.slice(splitAt).join(" ");
      const detailOptions = [
        { id: "correct", text: correctDetail },
        ...alternatives.map((item, i) => {
          const otherWords = wordsOf(item.text);
          return { id: "detail-" + i, text: otherWords.slice(Math.max(2, Math.floor(otherWords.length / 2))).join(" ") };
        })
      ];
      listening.push({
        id: "recall-detail-" + cue.id, type: "detail",
        prompt: `After "${prefix}…", what did the speaker say?`,
        audioCueOrders: [cueOrder(cue)],
        options: detailOptions,
        answerId: "correct"
      });
    }
    if (tokens.length >= 2) {
      const target = tokens[tokens.length - 1];
      const otherWords = unique(cues.flatMap(item => wordsOf(item.text)).filter(word => word.toLowerCase() !== target.toLowerCase())).slice(0, 2);
      if (otherWords.length) {
        listening.push({
          id: "recall-word-" + cue.id, type: "word-recognition",
          prompt: "Which word did you hear at the end of the phrase?",
          audioCueOrders: [cueOrder(cue)],
          options: [{ id: "correct", text: target }, ...otherWords.map((text, i) => ({ id: "word-" + i, text }))],
          answerId: "correct"
        });
      }
      listening.push({
        id: "recall-reconstruct-" + cue.id, type: "reconstruct",
        prompt: "Listen and rebuild the sentence in the correct order.",
        audioCueOrders: [cueOrder(cue)],
        words: tokens.length > 1 ? [...tokens.slice(1), tokens[0]!] : tokens,
        answer: tokens
      });
    }
  });
  const lessons: MicroLesson[] = approvedCards.slice(0, 12).map(card => ({
    id: "micro-" + card.id,
    title: card.highlightEn || card.focus,
    focus: /connected[ -]speech|linking|reduction/i.test(card.type + " " + card.focus) ? "connected-speech" : /pronunciation|stress|intonation/i.test(card.type + " " + card.focus) ? "pronunciation" : /grammar|structure|tense/i.test(card.type + " " + card.focus) ? "grammar" : "expression",
    sourceCueOrders: (() => { const source = cues.find(cue => cue.id === card.sourceCueId); return source ? [cueOrder(source)] : []; })(),
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
    cueOrders: [cueOrder(cue)],
    mode: index % 3 === 0 ? "no-subtitles" : index % 3 === 1 && wordsOf(cue.text).length >= 4 ? "gap-fill" : "connected-speech",
    prompt: index % 3 === 0 ? "Ouça sem legendas e identifique a ideia principal." : index % 3 === 1 && wordsOf(cue.text).length >= 4 ? "Ouça novamente e complete a palavra que falta." : "Observe como as palavras se conectam na fala.",
    expectedText: cue.text,
    sentence: index % 3 === 1 && wordsOf(cue.text).length >= 4 ? (() => { const tokens = wordsOf(cue.text); const target = tokens[Math.min(tokens.length - 1, Math.max(0, Math.floor(tokens.length / 2)))]; const at = cue.text.toLowerCase().indexOf(target.toLowerCase()); return at < 0 ? cue.text : cue.text.slice(0, at) + "_____" + cue.text.slice(at + target.length); })() : undefined,
    acceptedAnswers: index % 3 === 1 && wordsOf(cue.text).length >= 4 ? [wordsOf(cue.text)[Math.min(wordsOf(cue.text).length - 1, Math.max(0, Math.floor(wordsOf(cue.text).length / 2)))] || ""] : [cue.text]
  }));
  const speaking: SpeakingPrompt[] = selected.slice(0, 8).map((cue, index) => ({
    id: "speak-" + cue.id,
    cueOrders: [cueOrder(cue)],
    sourceText: cue.text,
    focus: (["rhythm", "pauses", "connected-speech", "intonation"] as const)[index % 4]
  }));
  const day2Activities = (["identify", "gap", "detail", "word-recognition", "reconstruct"] as const)
    .map(type => listening.find(item => item.type === type))
    .filter((item): item is ListeningQuestion => Boolean(item));
  const mixedListening = day2Activities.slice(0, 4);
  const finalListening = day2Activities;
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
      { day: 7, title: "Final Challenge", mode: "final-challenge", listening: finalListening, speaking: speaking.slice(0, 4), successCriteria: ["Compreender as falas sem depender das legendas.", "Reconhecer expressões estudadas em contexto.", "Reproduzir trechos com ritmo e entonação compreensíveis."] }
    ]
  };
}
