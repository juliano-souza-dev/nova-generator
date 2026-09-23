import { fireEvent, render, screen, act } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SourceWaveEditor } from "./SourceWaveEditor";

function Harness() {
  const playerRef = useRef<HTMLVideoElement>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(10000);
  return (
    <>
      <video ref={playerRef} aria-label="Video" />
      <input aria-label="Campo" />
      <output aria-label="intervalo">
        {start}-{end}
      </output>
      <SourceWaveEditor
        peaks={[0.1, 0.8, 0.2, 0.7]}
        startMs={start}
        endMs={end}
        durationMs={10000}
        onStartChange={setStart}
        onEndChange={setEnd}
        onReset={() => {
          setStart(0);
          setEnd(10000);
        }}
        playerRef={playerRef}
        failed={false}
        onRetry={() => {}}
      />
    </>
  );
}

describe("recorte por teclado", () => {
  it("permite recuperar falha de waveform", () => {
    const retry = vi.fn();
    render(
      <SourceWaveEditor
        peaks={[]}
        startMs={0}
        endMs={10000}
        durationMs={10000}
        onStartChange={vi.fn()}
        onEndChange={vi.fn()}
        onReset={vi.fn()}
        playerRef={{ current: null }}
        failed
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível carregar o áudio");
    fireEvent.click(screen.getByRole("button", { name: "Tentar carregar waveform" }));
    expect(retry).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  it("marca limites no playhead, navega com precisão e preserva campos", () => {
    render(<Harness />);
    const video = screen.getByLabelText("Video") as HTMLVideoElement;
    video.currentTime = 2;
    fireEvent.timeUpdate(video);
    fireEvent.keyDown(document.body, { key: "i" });
    video.currentTime = 7;
    fireEvent.timeUpdate(video);
    fireEvent.keyDown(document.body, { key: "o" });
    expect(screen.getByLabelText("intervalo")).toHaveTextContent("2000-7000");
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(video.currentTime).toBe(6.99);
    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
    expect(video.currentTime).toBe(7.09);
    fireEvent.keyDown(screen.getByLabelText("Campo"), { key: "i" });
    expect(screen.getByLabelText("intervalo")).toHaveTextContent("2000-7000");
    fireEvent.keyDown(document.body, { key: "+" });
    expect(screen.getByLabelText("Zoom")).toHaveTextContent("2×");
    fireEvent.click(screen.getByRole("button", { name: "Restaurar seleção" }));
    expect(screen.getByLabelText("intervalo")).toHaveTextContent("0-10000");
  });
  it("reproduz a seleção e para no limite escolhido", async () => {
    render(<Harness />);
    const video = screen.getByLabelText("Video") as HTMLVideoElement;
    video.currentTime = 2;
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByRole("button", { name: /Marcar início/ }));
    video.currentTime = 3;
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByRole("button", { name: /Marcar fim/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ouvir seleção" })));
    expect(video.currentTime).toBe(2);
    expect(video.play).toHaveBeenCalled();
    video.currentTime = 3.15;
    fireEvent.timeUpdate(video);
    expect(video.pause).toHaveBeenCalled();
    expect(video.currentTime).toBe(3);
    await act(async () => fireEvent.keyDown(document.body, { key: " " }));
    expect(video.play).toHaveBeenCalledTimes(2);
  });
});
