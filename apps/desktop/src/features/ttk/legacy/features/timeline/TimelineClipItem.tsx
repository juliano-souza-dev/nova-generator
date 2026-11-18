import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Copy, Trash2 } from "lucide-react";
import type { MediaAsset } from "../../shared/types";
import type { TimelineClip } from "./model";
import { clipDuration, timeLabel } from "./model";

type Props = {
  clip: TimelineClip;
  asset: MediaAsset;
  left: number;
  width: number;
  selected: boolean;
  grouped: boolean;
  multiSelected: boolean;
  audio?: boolean;
  mediaUrl?: string;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelect: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onTrimStart: (event: ReactPointerEvent<HTMLSpanElement>, edge: "start" | "end") => void;
  onTrimMove: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onTrimEnd: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
};

export default function TimelineClipItem({
  clip, asset, left, width, selected, grouped, multiSelected, audio = false, mediaUrl,
  onPointerDown, onPointerMove, onPointerUp, onSelect, onKeyDown,
  onTrimStart, onTrimMove, onTrimEnd, onDuplicate, onRemove,
}: Props) {
  const className = "timeline-clip positioned-clip " + (audio ? "audio" : asset.kind)
    + (selected ? " selected" : "")
    + (grouped ? " grouped" : "")
    + (multiSelected ? " multi-selected" : "");
  return <div
    role="button"
    tabIndex={0}
    className={className}
    style={{ left: left + "%", width: width + "%", touchAction: "none" }}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerUp}
    onClick={onSelect}
    onKeyDown={onKeyDown}
  >
    <span className="clip-trim-edge left" onPointerDown={event => onTrimStart(event, "start")} onPointerMove={onTrimMove} onPointerUp={onTrimEnd} onPointerCancel={onTrimEnd}/>
    <span className="clip-trim-edge right" onPointerDown={event => onTrimStart(event, "end")} onPointerMove={onTrimMove} onPointerUp={onTrimEnd} onPointerCancel={onTrimEnd}/>
    {!audio && asset.kind === "video" && mediaUrl && <video className="timeline-thumb-video" src={mediaUrl} muted preload="auto" playsInline/>}
    {!audio && asset.kind === "image" && mediaUrl && <img className="timeline-thumb-video" src={mediaUrl} alt=""/>}
    <b>{asset.name}</b>
    <small>{audio ? timeLabel(clipDuration(clip)) + " · " + timeLabel(clip.timelineStartMs) : timeLabel(clipDuration(clip))}</small>
    {audio && <span className="audio-waveform" aria-hidden="true">{Array.from({ length: 36 }, (_, index) => <i key={index} style={{ height: (18 + ((index * 17 + clip.id.length * 13) % 66)) + "%" }}/>)}</span>}
    <span className="clip-controls">
      <button type="button" title="Duplicar" onClick={event => { event.stopPropagation(); onDuplicate(); }}><Copy size={12}/></button>
      <button type="button" title="Excluir" onClick={event => { event.stopPropagation(); onRemove(); }}><Trash2 size={12}/></button>
    </span>
  </div>;
}
