import type { MediaSlide } from "./tiktok-api";

export type MusicLessonInput = {
  song: string;
  artist: string;
  start: string;
  end: string;
  expression: string;
  translation: string;
  explanation: string;
  pattern: string;
  patternExplanation: string;
  everydayEn: string;
  everydayPt: string;
  workEn: string;
  workPt: string;
  challengePt: string;
  challengeAnswerEn: string;
};

// Conteúdo demonstrativo e exemplos originais: nenhuma letra é baixada ou reconstruída.
export const MUSIC_LESSON_EXAMPLE: MusicLessonInput = {
  song: "Count on Me",
  artist: "Bruno Mars",
  start: "00:15",
  end: "01:10",
  expression: "Count on me",
  translation: "Conte comigo",
  explanation: "Count on alguém significa confiar ou contar com essa pessoa.",
  pattern: "If + situação, I'll + ação",
  patternExplanation: "If = se; I'll = I will (eu vou). Use para prometer uma ação futura.",
  everydayEn: "If you need help, I'll help you.",
  everydayPt: "Se precisar de ajuda, eu vou te ajudar.",
  workEn: "If the delivery is late, I'll call you.",
  workPt: "Se a entrega atrasar, vou te ligar.",
  challengePt: "Se chover, eu vou ficar em casa. Como você diria isso em inglês?",
  challengeAnswerEn: "If it rains, I'll stay home.",
};

export function parseMusicClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (seconds >= 60) return null;
  return minutes * 60 + seconds;
}

export function musicLessonDuration(input: MusicLessonInput): number | null {
  const start = parseMusicClock(input.start);
  const end = parseMusicClock(input.end);
  if (start === null || end === null || end <= start) return null;
  return end - start;
}

function validate(input: MusicLessonInput): number {
  const seconds = musicLessonDuration(input);
  if (seconds === null || seconds < 30 || seconds > 60) {
    throw new Error("Escolha um trecho entre 30 e 60 segundos, com início anterior ao fim.");
  }
  const fields: Array<[keyof MusicLessonInput, number]> = [
    ["song", 100],
    ["artist", 100],
    ["expression", 120],
    ["translation", 300],
    ["explanation", 800],
    ["pattern", 120],
    ["patternExplanation", 800],
    ["everydayEn", 600],
    ["everydayPt", 800],
    ["workEn", 600],
    ["workPt", 800],
    ["challengePt", 800],
    ["challengeAnswerEn", 600],
  ];
  for (const [field, max] of fields) {
    if (!input[field].trim() || input[field].length > max) {
      throw new Error(`Revise o campo ${field}: ele é obrigatório e aceita até ${max} caracteres.`);
    }
  }
  return seconds;
}

// Sete blocos somam exatamente a duração escolhida, sem ultrapassar 20 s por quadro.
export function buildMusicLesson(input: MusicLessonInput): MediaSlide[] {
  const seconds = validate(input);
  const weights = [6, 7, 8, 8, 10, 10, 6]; // 55 segundos no exemplo.
  const durations = weights.map((weight) => Math.round(((seconds * weight) / 55) * 2) * 500);
  durations[durations.length - 1] += seconds * 1000 - durations.reduce((a, b) => a + b, 0);

  const slide = (
    index: number,
    kind: MediaSlide["kind"],
    heading: string,
    en: string,
    pt: string,
    note: string,
    highlight = "",
  ): MediaSlide => ({
    id: crypto.randomUUID(),
    kind,
    heading,
    en,
    pt,
    note,
    highlight,
    speaker: "",
    duration_ms: durations[index],
  });

  return [
    slide(0, "cover", "INGLÊS COM MÚSICA", input.expression, `${input.song} · ${input.artist}`, ""),
    slide(
      1,
      "lyric",
      "EXPRESSÃO DO TRECHO",
      input.expression,
      input.translation,
      `Referência: ${input.start}–${input.end}. Insira áudio autorizado na exportação.`,
    ),
    slide(
      2,
      "lesson",
      "O QUE SIGNIFICA?",
      input.expression,
      input.explanation,
      input.translation,
      input.expression,
    ),
    slide(
      3,
      "lesson",
      "COMO USAR",
      input.pattern,
      input.patternExplanation,
      "Use essa estrutura em situações reais.",
      input.pattern,
    ),
    slide(
      4,
      "example",
      "NO DIA A DIA",
      input.everydayEn,
      input.everydayPt,
      "Exemplo original para praticar",
    ),
    slide(5, "example", "NO TRABALHO", input.workEn, input.workPt, "Inglês aplicado à rotina"),
    slide(
      6,
      "challenge",
      "DESAFIO FINAL",
      input.challengeAnswerEn,
      input.challengePt,
      "Responda nos comentários antes de conferir a resposta.",
    ),
  ];
}

export function musicLessonAiPrompt(input: MusicLessonInput): string {
  const seconds = validate(input);
  return [
    `Crie uma microaula de inglês de ${seconds} segundos, em 7 quadros, para TikTokMedia.`,
    `Música de referência: ${input.song}, de ${input.artist}; intervalo ${input.start}–${input.end}.`,
    `Expressão fornecida pelo editor: ${input.expression} = ${input.translation}.`,
    `Explicação: ${input.explanation}. Estrutura: ${input.pattern}. ${input.patternExplanation}.`,
    `Exemplo cotidiano: ${input.everydayEn} / ${input.everydayPt}.`,
    `Exemplo profissional: ${input.workEn} / ${input.workPt}.`,
    `Desafio: ${input.challengePt} Resposta: ${input.challengeAnswerEn}.`,
    "Ordem: abertura, expressão, explicação, estrutura, exemplo cotidiano, exemplo no trabalho, desafio.",
    "Use frases curtas, legendas EN/PT literais e exemplos originais. Não invente nem reproduza letra protegida da música.",
    "Respeite durações de 1–20 s por quadro e a duração total. Toda sugestão passará por revisão humana.",
  ].join("\n");
}
