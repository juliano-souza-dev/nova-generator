export const SCENE_SPEC_VERSION = "1.0" as const;

export type SceneLayout =
  | "category-list"
  | "question-answer"
  | "before-after"
  | "title-icon-caption"
  | "freeform";

export type SceneBlockRole = "title" | "item" | "question" | "answer" | "before" | "after" | "caption";

export type SceneBlock = {
  id: string;
  role: SceneBlockRole;
  text: string;
  icon?: string;
  iconName?: string;
  iconAnchor?: "left" | "right" | "top" | "bottom";
  iconSize?: number;
  iconColor?: string;
  anchor?: string;
  startOffsetMs?: number;
  durationMs?: number;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  accent?: string;
  align?: "left" | "center" | "right";
};

export type SceneSpec = {
  version: typeof SCENE_SPEC_VERSION;
  project?: {
    title?: string;
    language?: string[];
    aspectRatio?: "9:16" | "16:9" | "1:1";
  };
  scenes: Array<{
    id: string;
    name: string;
    layout: SceneLayout;
    durationMs: number;
    blocks: SceneBlock[];
    captions?: {
      enabled: boolean;
      mode: "off" | "source" | "bilingual" | "karaoke";
      sourceLanguage?: string;
      targetLanguage?: string;
      lines?: Array<{
        startMs: number;
        endMs: number;
        text: string;
        translation?: string;
        words?: Array<{ text: string; startMs: number; endMs: number }>;
      }>;
    };
    audio?: {
      source?: string;
      narration?: string;
      startMs?: number;
      volume?: number;
    };
    character?: {
      id?: string;
      asset?: string;
      x?: number;
      y?: number;
    };
  }>;
};

export type SceneTemplate = {
  id: Exclude<SceneLayout, "freeform">;
  name: string;
  description: string;
  preview: string;
  create: (startMs: number) => SceneSpec["scenes"][number];
};

const block = (
  role: SceneBlock["role"],
  text: string,
  x: number,
  y: number,
  fontSize: number,
  options: Partial<SceneBlock> = {},
): SceneBlock => ({
  id: crypto.randomUUID(),
  role,
  text,
  x,
  y,
  fontSize,
  color: "#ffffff",
  accent: "#65d6c0",
  align: "center",
  ...options,
});

export const SCENE_TEMPLATES: SceneTemplate[] = [
  {
    id: "category-list",
    name: "Lista de categorias",
    description: "Título e três itens organizados verticalmente.",
    preview: "TÍTULO · 01 · 02 · 03",
    create: () => ({
      id: crypto.randomUUID(),
      name: "Lista de categorias",
      layout: "category-list",
      durationMs: 6000,
      blocks: [
        block("title", "MAIN CATEGORIES", 50, 20, 58),
        block("item", "01  ·  CATEGORY ONE", 50, 42, 42, { align: "left" }),
        block("item", "02  ·  CATEGORY TWO", 50, 57, 42, { align: "left" }),
        block("item", "03  ·  CATEGORY THREE", 50, 72, 42, { align: "left" }),
      ],
    }),
  },
  {
    id: "question-answer",
    name: "Pergunta e resposta",
    description: "Pergunta em destaque e resposta revelada depois.",
    preview: "?  →  RESPOSTA",
    create: () => ({
      id: crypto.randomUUID(),
      name: "Pergunta e resposta",
      layout: "question-answer",
      durationMs: 6000,
      blocks: [
        block("question", "WHAT'S THE DIFFERENCE?", 50, 38, 62, { icon: "❓", startOffsetMs: 0 }),
        block("answer", "IT DEPENDS ON THE CONTEXT.", 50, 61, 46, { icon: "💡", startOffsetMs: 900, color: "#65d6c0" }),
      ],
    }),
  },
  {
    id: "before-after",
    name: "Antes e depois",
    description: "Comparação em duas colunas com títulos independentes.",
    preview: "ANTES  |  DEPOIS",
    create: () => ({
      id: crypto.randomUUID(),
      name: "Antes e depois",
      layout: "before-after",
      durationMs: 6000,
      blocks: [
        block("title", "COMPARE", 50, 20, 58),
        block("before", "BEFORE", 27, 42, 36, { color: "#f0a0a0" }),
        block("item", "OLD VERSION", 27, 56, 31, { align: "center" }),
        block("after", "AFTER", 73, 42, 36, { color: "#65d6c0" }),
        block("item", "NEW VERSION", 73, 56, 31, { align: "center" }),
      ],
    }),
  },
  {
    id: "title-icon-caption",
    name: "Título + ícone + legenda",
    description: "Conceito central com ícone e explicação curta.",
    preview: "ÍCONE · TÍTULO · LEGENDA",
    create: () => ({
      id: crypto.randomUUID(),
      name: "Título + ícone + legenda",
      layout: "title-icon-caption",
      durationMs: 6000,
      blocks: [
        block("title", "TAKE A SHOWER", 50, 35, 66, { icon: "🚿", anchor: "title" }),
        block("caption", "A common English expression.", 50, 58, 36, { color: "#d8d4df" }),
      ],
    }),
  },
];

export function buildTemplateScene(templateId: string, startMs: number) {
  const template = SCENE_TEMPLATES.find((item) => item.id === templateId);
  if (!template) throw new Error("Template de cena não encontrado.");
  return { ...template.create(startMs), startMs };
}

export function validateSceneSpec(value: unknown): value is SceneSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== SCENE_SPEC_VERSION || !Array.isArray(candidate.scenes) || candidate.scenes.length === 0) return false;
  if (candidate.project !== undefined) {
    if (!candidate.project || typeof candidate.project !== "object" || Array.isArray(candidate.project)) return false;
    const project = candidate.project as Record<string, unknown>;
    if (project.title !== undefined && typeof project.title !== "string") return false;
    if (project.language !== undefined && (!Array.isArray(project.language) || !project.language.every(item => typeof item === "string"))) return false;
    if (project.aspectRatio !== undefined && !["9:16", "16:9", "1:1"].includes(String(project.aspectRatio))) return false;
  }
  return candidate.scenes.every((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const scene = raw as Record<string, unknown>;
    if (typeof scene.id !== "string" || !scene.id.trim() || typeof scene.name !== "string" || !scene.name.trim()) return false;
    if (!["category-list", "question-answer", "before-after", "title-icon-caption", "freeform"].includes(String(scene.layout))) return false;
    if (typeof scene.durationMs !== "number" || !Number.isFinite(scene.durationMs) || scene.durationMs <= 0) return false;
    if (!Array.isArray(scene.blocks) || scene.blocks.length === 0) return false;
    const validBlocks = scene.blocks.every((rawBlock) => {
      if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) return false;
      const item = rawBlock as Record<string, unknown>;
      return typeof item.id === "string" && !!item.id.trim()
        && typeof item.text === "string"
        && ["title", "item", "question", "answer", "before", "after", "caption"].includes(String(item.role))
        && typeof item.x === "number" && Number.isFinite(item.x) && item.x >= 0 && item.x <= 100
        && typeof item.y === "number" && Number.isFinite(item.y) && item.y >= 0 && item.y <= 100
        && typeof item.fontSize === "number" && Number.isFinite(item.fontSize) && item.fontSize >= 8 && item.fontSize <= 240
        && typeof item.color === "string"
        && (item.accent === undefined || typeof item.accent === "string")
        && (item.align === undefined || ["left", "center", "right"].includes(String(item.align)))
        && (item.icon === undefined || typeof item.icon === "string")
        && (item.anchor === undefined || typeof item.anchor === "string")
        && (item.startOffsetMs === undefined || (typeof item.startOffsetMs === "number" && Number.isFinite(item.startOffsetMs) && item.startOffsetMs >= 0))
        && (item.durationMs === undefined || (typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs > 0))
        && (item.iconAnchor === undefined || ["left", "right", "top", "bottom"].includes(String(item.iconAnchor)))
        && (item.iconSize === undefined || (typeof item.iconSize === "number" && Number.isFinite(item.iconSize) && item.iconSize >= 12 && item.iconSize <= 180))
        && (item.iconName === undefined || typeof item.iconName === "string")
        && (item.iconColor === undefined || typeof item.iconColor === "string");
    });
    if (!validBlocks) return false;
    if (scene.captions !== undefined) {
      if (!scene.captions || typeof scene.captions !== "object" || Array.isArray(scene.captions)) return false;
      const captions = scene.captions as Record<string, unknown>;
      if (typeof captions.enabled !== "boolean" || !["off", "source", "bilingual", "karaoke"].includes(String(captions.mode))) return false;
      if (captions.lines !== undefined && (!Array.isArray(captions.lines) || !captions.lines.every(line => {
        if (!line || typeof line !== "object" || Array.isArray(line)) return false;
        const cue = line as Record<string, unknown>;
        if (typeof cue.startMs !== "number" || !Number.isFinite(cue.startMs) || cue.startMs < 0
          || typeof cue.endMs !== "number" || !Number.isFinite(cue.endMs) || cue.endMs <= cue.startMs
          || typeof cue.text !== "string") return false;
        if (cue.translation !== undefined && typeof cue.translation !== "string") return false;
        return cue.words === undefined || (Array.isArray(cue.words) && cue.words.every(word => {
          if (!word || typeof word !== "object" || Array.isArray(word)) return false;
          const entry = word as Record<string, unknown>;
          return typeof entry.text === "string" && typeof entry.startMs === "number" && Number.isFinite(entry.startMs)
            && typeof entry.endMs === "number" && Number.isFinite(entry.endMs) && entry.endMs > entry.startMs;
        }));
      }))) return false;
    }
    if (scene.audio !== undefined) {
      if (!scene.audio || typeof scene.audio !== "object" || Array.isArray(scene.audio)) return false;
      const audio = scene.audio as Record<string, unknown>;
      if (audio.source !== undefined && typeof audio.source !== "string") return false;
      if (audio.narration !== undefined && typeof audio.narration !== "string") return false;
      if (audio.startMs !== undefined && (typeof audio.startMs !== "number" || !Number.isFinite(audio.startMs) || audio.startMs < 0)) return false;
      if (audio.volume !== undefined && (typeof audio.volume !== "number" || !Number.isFinite(audio.volume) || audio.volume < 0 || audio.volume > 100)) return false;
    }
    if (scene.character !== undefined) {
      if (!scene.character || typeof scene.character !== "object" || Array.isArray(scene.character)) return false;
      const character = scene.character as Record<string, unknown>;
      if (character.id !== undefined && typeof character.id !== "string") return false;
      if (character.asset !== undefined && typeof character.asset !== "string") return false;
      if (character.x !== undefined && (typeof character.x !== "number" || !Number.isFinite(character.x) || character.x < 0 || character.x > 100)) return false;
      if (character.y !== undefined && (typeof character.y !== "number" || !Number.isFinite(character.y) || character.y < 0 || character.y > 100)) return false;
    }
    return true;
  });
}

export function createSceneSpecFromMotion(
  items: Array<{
    id: string;
    text: string;
    icon?: string;
    lucideIconName?: string;
    lucideIconAnchor?: "left" | "right" | "top" | "bottom";
    lucideIconSize?: number;
    lucideIconColor?: string;
    startMs: number;
    endMs: number;
    x: number;
    y: number;
    fontSize: number;
    color: string;
    accent?: string;
    textAlign?: "left" | "center" | "right";
    preset: string;
  }>,
): SceneSpec {
  const start = items.length ? Math.min(...items.map((item) => item.startMs)) : 0;
  const end = items.length ? Math.max(...items.map((item) => item.endMs)) : 3000;
  return {
    version: SCENE_SPEC_VERSION,
    project: { title: "FrameLab scene export", aspectRatio: "9:16" },
    scenes: [{
      id: crypto.randomUUID(),
      name: "Cena exportada",
      layout: "freeform",
      durationMs: Math.max(1000, end - start),
      blocks: items.map((item) => ({
        id: item.id,
        role: "item",
        text: item.text,
        icon: item.icon,
        iconName: item.lucideIconName,
        iconAnchor: item.lucideIconAnchor,
        iconSize: item.lucideIconSize,
        iconColor: item.lucideIconColor,
        startOffsetMs: Math.max(0, item.startMs - start),
        durationMs: Math.max(300, item.endMs - item.startMs),
        x: item.x,
        y: item.y,
        fontSize: item.fontSize,
        color: item.color,
        accent: item.accent,
        align: item.textAlign ?? "center",
      })),
    }],
  };
}
