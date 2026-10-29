import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, FileJson, Layers3, Music2, Play, Sparkles } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "../../components/PageHeader";
import { IHubCardPreview } from "../materials/IHubCardPreview";
import { apiRequest, apiUrl } from "../../lib/api";
import { studioApi } from "../../lib/studio-api";
import type { AnkiDidacticCard } from "../../lib/api.types";
import "./cards-only.css";

type Prepared = { title: string; cards: AnkiDidacticCard[]; count: number };
type JobSubmitted = { job_id: string; export_id: string; status: string; count: number };

type ProposedCards = Prepared & { needs_review: boolean };

async function validateFile(file: File): Promise<Prepared> {
  const body = new FormData();
  body.append("file", file);
  return apiRequest<Prepared>("/cards-only/validate", { method: "POST", body });
}

async function generateFromSource(file: File): Promise<ProposedCards> {
  const body = new FormData();
  body.append("file", file);
  return apiRequest<ProposedCards>("/cards-only/generate", { method: "POST", body });
}

async function submitCards(file: File, voiceId: string, youtube: string, audio: File | null) {
  const body = new FormData();
  body.append("file", file);
  body.append("voice_id", voiceId);
  if (audio) body.append("audio_file", audio);
  else body.append("youtube_url", youtube.trim());
  return apiRequest<JobSubmitted>("/cards-only/exports", { method: "POST", body });
}

export function CardsPage() {
  const [json, setJson] = useState<File | null>(null);
  const [source, setSource] = useState<"youtube" | "audio">("youtube");
  const [youtube, setYoutube] = useState("");
  const [audio, setAudio] = useState<File | null>(null);
  const [voice, setVoice] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState<JobSubmitted | null>(null);
  const [aiDraft, setAiDraft] = useState(false);
  const voices = useQuery({ queryKey: ["cards-voices"], queryFn: studioApi.voices });
  const validate = useMutation({ mutationFn: validateFile });
  const generate = useMutation({
    mutationFn: () => generateFromSource(json!),
    onSuccess: (result) => {
      const prepared = new File(
        [JSON.stringify({ title: result.title, cards: result.cards })],
        "cards-preparados.json",
        { type: "application/json" },
      );
      setJson(prepared);
      setAiDraft(true);
      validate.mutate(prepared);
      setSubmitted(null);
    },
  });
  const exporting = useMutation({
    mutationFn: () => submitCards(json!, voice, youtube, source === "audio" ? audio : null),
    onSuccess: setSubmitted,
  });
  const job = useQuery({
    queryKey: ["cards-job", submitted?.job_id],
    queryFn: () => studioApi.job(submitted!.job_id),
    enabled: Boolean(submitted?.job_id),
    refetchInterval: (query) =>
      ["queued", "running", "retryable"].includes(query.state.data?.status ?? "") ? 2000 : false,
  });
  const ready = job.data?.status === "succeeded";
  const cards = validate.data?.cards ?? [];
  const current = active !== null ? cards[active] : null;
  return (
    <section className="cards-studio">
      <PageHeader title="Cards" description="Produza somente os cards IHUB, o Anki e os áudios. Sem o kit editorial completo." />
      <div className="cards-studio-grid">
        <div className="cards-panel">
          <h2><FileJson size={18} /> Importar JSON</h2>
          <p>Importe a seção Anki de um JSON de materiais, uma proposta didática ou um hub_final.</p>
          <input type="file" aria-label="Arquivo JSON de cards" accept=".json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setJson(file);
              setSubmitted(null);
              setAiDraft(false);
              validate.reset();
              if (file) validate.mutate(file);
            }} />
          {validate.isPending && <p role="status">Conferindo os cards…</p>}
          {validate.isError && <div className="cards-ai-suggestion">
            <p role="alert">{validate.error.message}</p>
            <p>Se o JSON contém falas e traduções, gere primeiro as mini-aulas dos cards.</p>
            <button type="button" disabled={!json || generate.isPending}
              onClick={() => generate.mutate()}>
              <Sparkles size={16} /> {generate.isPending ? "Gerando mini-aulas…" : "Gerar cards com IA"}
            </button>
            {generate.isError && <p role="alert">{generate.error.message}</p>}
          </div>}
          {aiDraft && validate.data && (
            <p className="cards-review-warning">Cards criados pela IA: revise cada tradução e mini-aula na prévia antes de exportar.</p>
          )}
          {validate.data && <div className="cards-success">
            <strong>{validate.data.title}</strong>
            <span>{validate.data.count} cards didáticos encontrados</span>
          </div>}
          <h2><Music2 size={18} /> Origem do áudio</h2>
          <p>Escolha de onde veio o conteúdo. O Anki receberá WAVs da frase pedagógica gerados pela voz selecionada.</p>
          <div className="cards-source-choices" role="group" aria-label="Origem dos cards">
            <button type="button" aria-pressed={source === "youtube"}
              onClick={() => setSource("youtube")}>YouTube</button>
            <button type="button" aria-pressed={source === "audio"}
              onClick={() => setSource("audio")}>MP3 ou WAV</button>
          </div>
          {source === "youtube" ? (
            <label>Link do YouTube
              <input aria-label="URL do YouTube" type="url" placeholder="https://youtube.com/watch?v=..."
                value={youtube} onChange={(event) => setYoutube(event.target.value)} />
            </label>
          ) : (
            <label>Arquivo de áudio original
              <input aria-label="MP3 ou WAV de origem" type="file" accept=".mp3,.wav,audio/mpeg,audio/wav"
                onChange={(event) => setAudio(event.target.files?.[0] ?? null)} />
            </label>
          )}
          <label>Voz para os cards Anki
            <select aria-label="Voz para o Anki" value={voice} onChange={(event) => setVoice(event.target.value)}>
              <option value="">Selecione a voz</option>
              {voices.data?.map((item) =>
                <option key={item.id} value={item.id}>{item.name} (v{item.version})</option>
              )}
            </select>
          </label>
          <button className="cards-create-button" type="button" disabled={
            !json || !validate.data || !voice || exporting.isPending ||
            (source === "youtube" ? !youtube.trim() : !audio)
          } onClick={() => exporting.mutate()}>
            <Sparkles size={17} /> {exporting.isPending ? "Preparando…" : "Gerar cards + Anki + áudios"}
          </button>
          {exporting.isError && <p role="alert">{exporting.error.message}</p>}
          {submitted && (
            <div className="cards-job">
              <strong>Exportação: {job.data?.status ?? submitted.status}</strong>
              {job.data?.error_message && <p role="alert">{job.data.error_message}</p>}
              {job.isError && <p role="alert">{job.error.message}</p>}
              {ready && <div className="cards-downloads">
                <a href={apiUrl(`/cards-only/exports/${submitted.export_id}/bundle`)}>
                  <Download size={15} /> ZIP: Anki + JSON + áudios
                </a>
                <a href={apiUrl(`/cards-only/exports/${submitted.export_id}/anki.apkg`)}>Baixar Anki (.apkg)</a>
                <a href={apiUrl(`/cards-only/exports/${submitted.export_id}/cards.json`)}>Baixar JSON de cards</a>
              </div>}
            </div>
          )}
        </div>
        <div className="cards-panel cards-review">
          <h2><Layers3 size={18} /> Cards encontrados</h2>
          <p>Prévia com o mesmo modelo visual do IHUB. Confira frases, tradução e mini-aula antes de gerar.</p>
          {cards.length === 0 ? <div className="cards-empty">Importe o JSON para visualizar os cards.</div> : (
            <div className="cards-items">
              {cards.map((card, index) => (
                <button type="button" className="cards-item" key={card.card_id}
                  onClick={() => setActive(index)}>
                  <span className="cards-count">{index + 1}</span>
                  <span><strong>{card.front_en}</strong>
                    <small>{card.back_pt}</small>
                    <em>{card.focus_text} · {card.card_type}</em>
                  </span>
                  <Play size={16} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {current && active !== null && (
        <IHubCardPreview
          card={{
            cue_id: current.cue_id,
            approved_en: current.front_en,
            approved_pt: current.back_pt,
            speaker: "",
            audio_url: ready && submitted ? apiUrl(`/cards-only/exports/${submitted.export_id}/audio/${current.card_id}`) : null,
            highlights: [],
            pedagogical: { ...current, scene_id: current.scene_id ?? current.cue_id },
          }}
          position={active + 1}
          total={cards.length}
          onClose={() => setActive(null)}
          onPrevious={active > 0 ? () => setActive(active - 1) : undefined}
          onNext={active < cards.length - 1 ? () => setActive(active + 1) : undefined}
        />
      )}
    </section>
  );
}
