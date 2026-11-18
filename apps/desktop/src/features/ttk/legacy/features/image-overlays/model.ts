export type ImageOverlay = { id:string; assetId:string; startMs:number; endMs:number; x:number; y:number; width:number; height:number; soundId?:string; soundVolume:number; visible?:boolean; locked?:boolean; entranceAnimation?: "none" | "fade" | "slide-left" | "slide-right" | "slide-up" | "slide-down"; entranceDurationMs?:number };

export function imageOverlayEntranceState(item: ImageOverlay, playheadMs: number) {
  const animation = item.entranceAnimation || "none";
  const configuredDuration = Math.max(100, Math.min(3000, item.entranceDurationMs ?? 600));
  const duration = Math.min(configuredDuration, Math.max(1, item.endMs - item.startMs));
  const progress = Math.max(0, Math.min(1, (playheadMs - item.startMs) / duration));
  const eased = 1 - Math.pow(1 - progress, 3);
  let transform = "translate(-50%,-50%)";
  let opacity = 1;
  if (animation === "fade") opacity = progress;
  if (animation === "slide-left") transform += " translateX(-" + ((1 - eased) * 100) + "%)";
  if (animation === "slide-right") transform += " translateX(" + ((1 - eased) * 100) + "%)";
  if (animation === "slide-up") transform += " translateY(" + ((1 - eased) * 100) + "%)";
  if (animation === "slide-down") transform += " translateY(-" + ((1 - eased) * 100) + "%)";
  return { transform, opacity };
}
