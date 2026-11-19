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
