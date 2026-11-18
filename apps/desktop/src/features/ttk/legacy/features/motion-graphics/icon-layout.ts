import type { MotionGraphic } from "./model";

export function getLucideIconExportOffset(item: MotionGraphic, iconSize: number) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const fontSize = Math.max(18, item.fontSize);
  const fontWeight = item.fontWeight || 900;
  const fontFamily = item.fontFamily || "Arial";
  if (context) context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const label = (item.icon ? item.icon + " " : "") + item.text;
  const textWidth = context ? context.measureText(label).width : fontSize * Math.max(1, label.length) * 0.55;
  const textHeight = fontSize * 1.2;
  const gap = Math.max(4, iconSize * 0.22);
  const vertical = item.lucideIconAnchor === "top" || item.lucideIconAnchor === "bottom";
  const groupWidth = vertical ? Math.max(iconSize, textWidth) : iconSize + gap + textWidth;
  const groupHeight = vertical ? iconSize + gap + textHeight : Math.max(iconSize, textHeight);
  const groupLeft = item.textAlign === "left" ? 0 : item.textAlign === "right" ? -groupWidth : -groupWidth / 2;
  const groupTop = -groupHeight / 2;
  const x = vertical
    ? groupLeft + (groupWidth - iconSize) / 2
    : item.lucideIconAnchor === "right" ? groupLeft + iconSize + gap + textWidth : groupLeft;
  const y = item.lucideIconAnchor === "top"
    ? groupTop
    : item.lucideIconAnchor === "bottom" ? groupTop + textHeight + gap
    : groupTop + (groupHeight - iconSize) / 2;
  return { lucideIconOffsetX: x, lucideIconOffsetY: y };
}
