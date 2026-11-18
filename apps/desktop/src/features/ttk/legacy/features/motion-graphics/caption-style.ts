export function captionBackgroundRgba(color: string | undefined, opacity: number | undefined) {
  const safeOpacity = Math.max(0, Math.min(1, opacity ?? 0.76));
  const match = /^#?([0-9a-f]{6})$/i.exec(color || "000000");
  if (!match) return `rgba(0,0,0,${safeOpacity})`;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${safeOpacity})`;
}
