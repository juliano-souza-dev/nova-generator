import type { MediaProject, MediaSlide } from "./tiktok-api";

const NAVY = "#13233e";
const DEEP = "#0c1930";
const TEAL = "#05a6a9";
const MUTED = "#5b6c85";
const ORANGE = "#fa8b48";
const LIGHT = "#f5f8fd";

type Palette = {
  dark: string;
  paper: string;
  accent: string;
  secondary: string;
};

function palette(theme: MediaProject["theme"]): Palette {
  if (theme === "warm")
    return {
      dark: "#362339",
      paper: "#fff8f1",
      accent: "#b55238",
      secondary: "#f1c8b1",
    };
  if (theme === "midnight")
    return {
      dark: "#080e22",
      paper: "#e9eef9",
      accent: "#8097ff",
      secondary: "#18264c",
    };
  return { dark: DEEP, paper: LIGHT, accent: TEAL, secondary: "#ccefe8" };
}

function round(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function lines(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string[] {
  const all: string[] = [];
  value.split("\n").forEach((paragraph) => {
    if (!paragraph.trim()) {
      all.push("");
      return;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      const attempt = current ? `${current} ${word}` : word;
      if (ctx.measureText(attempt).width <= maxWidth) {
        current = attempt;
      } else {
        if (current) all.push(current);
        current = word;
        while (ctx.measureText(current).width > maxWidth && current.length > 1) {
          let end = current.length - 1;
          while (end > 1 && ctx.measureText(current.slice(0, end)).width > maxWidth) end--;
          all.push(current.slice(0, end));
          current = current.slice(end);
        }
      }
    }
    all.push(current);
  });
  return all;
}

function type(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  width: number,
  height: number,
  size: number,
  color: string,
  weight = 750,
  align: CanvasTextAlign = "left",
) {
  if (!value.trim()) return;
  let fontSize = size;
  let wrapped: string[] = [];
  while (fontSize >= 26) {
    ctx.font = `${weight} ${fontSize}px Inter, Arial, sans-serif`;
    wrapped = lines(ctx, value, width);
    if (wrapped.length * fontSize * 1.19 <= height) break;
    fontSize -= 3;
  }
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  const atX = align === "center" ? x + width / 2 : align === "right" ? x + width : x;
  wrapped.slice(0, Math.max(1, Math.floor(height / (fontSize * 1.19)))).forEach((line, i) => {
    ctx.fillText(line, atX, y + i * fontSize * 1.19, width);
  });
  ctx.textAlign = "left";
}

function header(ctx: CanvasRenderingContext2D, p: Palette, dark: boolean) {
  type(ctx, "iHUB", 92, 80, 210, 90, 52, dark ? "#fff" : NAVY, 850);
  type(ctx, "ENGLISH", 268, 102, 225, 70, 30, dark ? "#8de1d9" : p.accent, 850);
  type(ctx, "ENGLISH IN CONTEXT", 92, 164, 720, 70, 28, dark ? "#96d5d0" : p.accent, 800);
  ctx.strokeStyle = dark ? "#365472" : "#d3dfeb";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(92, 242);
  ctx.lineTo(988, 242);
  ctx.stroke();
}

function footer(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  dark: boolean,
  index: number,
  total: number,
) {
  const foreground = dark ? "#bed3e5" : MUTED;
  ctx.strokeStyle = dark ? "#365472" : "#d3dfeb";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(92, 1676);
  ctx.lineTo(988, 1676);
  ctx.stroke();
  type(ctx, "iHub English  ·  INGLÊS COM SÉRIES", 92, 1716, 680, 58, 27, foreground, 750);
  type(ctx, `${index + 1}/${total}`, 856, 1716, 132, 58, 27, foreground, 750, "right");
  type(ctx, "Uma cena. Inglês para a vida real.", 92, 1790, 820, 50, 25, foreground, 450);
  ctx.fillStyle = p.accent;
  ctx.fillRect(92, 1875, 896 * ((index + 1) / total), 7);
}

export function paintSlide(
  ctx: CanvasRenderingContext2D,
  slide: MediaSlide,
  project: MediaProject,
  index: number,
) {
  const w = 1080;
  const h = 1920;
  ctx.clearRect(0, 0, w, h);
  const p = palette(project.theme);
  const dark = ["cover", "challenge", "lyric"].includes(slide.kind);
  const bg = dark ? p.dark : p.paper;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (dark) {
    ctx.strokeStyle = p.accent;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 15;
    ctx.beginPath();
    ctx.arc(1090, 220, 405, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-120, 1520, 520, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  header(ctx, p, dark);
  const white = dark ? "#ffffff" : NAVY;
  const secondary = dark ? "#b9d4e5" : MUTED;
  const heading = (
    slide.heading || (slide.kind === "lyric" ? "LYRICS + TRADUÇÃO" : "MINI-AULA")
  ).toUpperCase();

  if (slide.kind === "cover") {
    round(ctx, 88, 340, 520, 74, 37, dark ? "#1b566a" : p.secondary);
    type(ctx, heading, 120, 358, 800, 55, 28, "#83e6e0", 800);
    type(ctx, slide.en || project.title, 92, 490, 900, 570, 83, white, 820);
    ctx.fillStyle = ORANGE;
    ctx.fillRect(92, 1220, 112, 12);
    type(ctx, slide.pt || slide.note, 92, 1290, 896, 300, 43, secondary, 500);
    round(ctx, 88, 1545, 900, 78, 29, ORANGE);
    type(ctx, "DESLIZE PARA APRENDER   →", 145, 1564, 780, 55, 30, DEEP, 850);
  } else if (slide.kind === "challenge") {
    round(ctx, 88, 328, 310, 72, 36, "#1c566c");
    type(ctx, "AGORA É SUA VEZ", 120, 346, 550, 52, 29, "#9be7db", 800);
    type(ctx, slide.pt || slide.en, 92, 488, 900, 580, 77, white, 840);
    round(ctx, 90, 1220, 900, 248, 38, "#214059");
    type(
      ctx,
      slide.note || "Pense na resposta antes de ler a legenda.",
      127,
      1260,
      826,
      164,
      38,
      "#fff",
      500,
    );
    type(ctx, "DESAFIO • INGLÊS EM CONTEXTO", 92, 1536, 850, 80, 28, "#90d0d9", 780);
  } else if (slide.kind === "lyric") {
    round(ctx, 92, 340, 460, 68, 34, "#184960");
    type(ctx, heading, 125, 359, 800, 56, 28, "#a8e4e0", 780);
    type(ctx, slide.en, 94, 555, 892, 480, 85, white, 830, "center");
    ctx.fillStyle = ORANGE;
    ctx.fillRect(455, 1110, 170, 10);
    type(ctx, slide.pt, 100, 1190, 880, 285, 53, "#c4deec", 540, "center");
    if (slide.note) type(ctx, slide.note, 100, 1510, 880, 110, 32, "#9bb8cf", 480, "center");
  } else if (slide.kind === "example") {
    type(ctx, heading, 92, 325, 896, 80, 36, p.accent, 840);
    type(ctx, slide.note || "Agora, use na vida real.", 92, 427, 896, 160, 62, NAVY, 830);
    round(ctx, 82, 660, 916, 520, 42, "#ffffff");
    ctx.strokeStyle = "#d0e1eb";
    ctx.lineWidth = 3;
    ctx.stroke();
    round(ctx, 114, 698, 286, 56, 28, "#dff3ef");
    type(ctx, "NA PRÁTICA", 145, 710, 250, 50, 26, p.accent, 840);
    type(ctx, slide.en, 120, 815, 840, 220, 52, NAVY, 820);
    type(ctx, slide.pt, 120, 1060, 836, 220, 36, MUTED, 480);
    if (slide.highlight) {
      round(ctx, 86, 1324, 910, 150, 38, "#def4f2");
      type(ctx, slide.highlight, 125, 1371, 820, 95, 40, "#067f87", 800);
    }
  } else {
    type(ctx, heading, 92, 315, 896, 90, 36, p.accent, 850);
    type(ctx, slide.note || "Entenda o padrão", 92, 425, 896, 195, 59, NAVY, 820);
    round(ctx, 78, 680, 924, 235, 40, NAVY);
    type(ctx, slide.en, 114, 722, 852, 170, 58, "#fff", 790, "center");
    type(ctx, slide.pt, 94, 1000, 890, 300, 47, NAVY, 520);
    if (slide.highlight) {
      round(ctx, 86, 1370, 910, 178, 36, "#def4f2");
      type(ctx, slide.highlight, 122, 1410, 830, 110, 36, "#05777c", 780);
    }
  }
  footer(ctx, p, dark, index, project.slides.length);
}

export function imageForSlide(project: MediaProject, index: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Canvas indisponível neste navegador."));
  paintSlide(ctx, project.slides[index], project, index);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Não foi possível criar o PNG."));
    }, "image/png");
  });
}
