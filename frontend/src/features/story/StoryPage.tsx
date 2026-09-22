import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import { ApiError } from "../../lib/api";
import type { StoryProduction } from "../../lib/api.types";
import { studioApi } from "../../lib/studio-api";
import "./story.css";

const idPattern = /^[A-Za-z0-9_-]{11}$/;
function validYoutube(value: string) {
  if (idPattern.test(value.trim())) return true;
  try {
    const url = new URL(value);
    if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname))
      return false;
    const id =
      url.hostname === "youtu.be"
        ? url.pathname.slice(1)
        : url.pathname === "/watch"
          ? url.searchParams.get("v")
          : url.pathname.split("/")[2];
    return !!id && idPattern.test(id);
  } catch {
    return false;
  }
}

export function StoryPage() {
  const [production, setProduction] = useState<StoryProduction | null>(null);
  const [savedId] = useState(() => sessionStorage.getItem("story-production-id"));
  const [voice, setVoice] = useState("");
  const [youtube, setYoutube] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: studioApi.uploadStory,
    onSuccess: (value) => {
      setProduction(value);
      setJobId(null);
      sessionStorage.setItem("story-production-id", value.id);
    },
  });
  const saved = useQuery({
    queryKey: ["story", savedId],
    queryFn: () => studioApi.story(savedId!),
    enabled: !!savedId,
  });
  useEffect(() => {
    if (saved.data && !production) setProduction(saved.data);
  }, [saved.data, production]);
  const voices = useQuery({
    queryKey: ["voices"],
    queryFn: studioApi.voices,
    enabled: !!production,
  });
  const render = useMutation({
    mutationFn: () => studioApi.renderStory(production!.id, voice),
    onSuccess: (value) => setJobId(value.job_id),
  });
  const job = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => studioApi.job(jobId!),
    enabled: !!jobId,
    refetchInterval: (query) =>
      ["queued", "running", "retryable"].includes(query.state.data?.status ?? "") ? 3000 : false,
  });
  const refresh = useMutation({
    mutationFn: () => studioApi.story(production!.id),
    onSuccess: setProduction,
  });
  const publish = useMutation({
    mutationFn: () => studioApi.publishStory(production!.id, youtube),
  });
  const issues = upload.error instanceof ApiError ? upload.error.issues : undefined;

  return (
    <section>
      <PageHeader
        title="Modo História"
        description="Envie o ZIP, revise cada cue, selecione uma voz e acompanhe a renderização antes de publicar."
      />
      <div className="panel story-upload">
        <label htmlFor="story-zip">Pacote da História (.zip)</label>
        <input
          id="story-zip"
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
          }}
        />
        {upload.isPending && <p>Validando ZIP…</p>}
        {upload.isError && (
          <div role="alert" className="field-error">
            <strong>Corrija o pacote e envie novamente.</strong>
            {issues ? (
              <ul>
                {issues.map((issue, index) => (
                  <li key={index}>
                    <code>{issue.path}</code>: {issue.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{upload.error.message}</p>
            )}
          </div>
        )}
      </div>
      {!production && !upload.isPending && <p>Envie o pacote para iniciar a revisão.</p>}
      {production && (
        <>
          <div className="story-heading">
            <h2>{production.title}</h2>
            <span>
              {production.language} · {production.aspect_ratio} · {production.cues.length} cues
            </span>
          </div>
          <ol className="story-cues">
            {production.cues.map((cue) => (
              <li key={cue.order} className="panel">
                <img src={production.image_urls[cue.image]} alt={`Imagem do cue ${cue.order}`} />
                <div>
                  <h3>Cue {cue.order}</h3>
                  <p lang="en">{cue.en}</p>
                  <p lang="pt-BR">{cue.pt}</p>
                  {cue.highlights.length > 0 && (
                    <ul className="story-highlights">
                      {cue.highlights.map((h, i) => (
                        <li key={i}>
                          <strong>{h.text}</strong> · {h.pt}{" "}
                          <small>
                            ({h.type}, ocorrência {h.occurrence})
                          </small>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="panel story-actions">
            <h2>Voz e render</h2>
            <p>Revise o texto e as imagens antes de iniciar o processamento.</p>
            <label htmlFor="story-voice">Perfil de voz</label>
            <select
              id="story-voice"
              value={voice}
              onChange={(event) => setVoice(event.target.value)}
            >
              <option value="">Selecione uma voz</option>
              {voices.data?.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · v{profile.version}
                </option>
              ))}
            </select>
            <Link to="/voices">Criar ou gerenciar vozes</Link>
            {voices.isError && (
              <p role="alert" className="field-error">
                {voices.error.message}
              </p>
            )}
            <button
              className="primary-button"
              disabled={!voice || render.isPending}
              onClick={() => render.mutate()}
            >
              Iniciar render
            </button>
            {render.isError && (
              <p role="alert" className="field-error">
                {render.error.message}
              </p>
            )}
            {jobId && (
              <p>
                Job: <Link to="/jobs">{jobId}</Link> · {job.data?.status ?? "carregando"}
                {job.data?.error_message && ` · ${job.data.error_message}`}
              </p>
            )}
            {job.data?.status === "succeeded" && (
              <button onClick={() => refresh.mutate()}>Carregar prévia</button>
            )}
          </div>
          {production.preview_url && (
            <div className="panel story-publication">
              <h2>Prévia e publicação</h2>
              <video controls src={production.preview_url} aria-label="Prévia da História" />
              <p>
                Faça o upload manual do vídeo ao YouTube e informe o URL ou ID para gerar o JSON
                público.
              </p>
              <label htmlFor="story-youtube">URL ou ID do YouTube</label>
              <input
                id="story-youtube"
                value={youtube}
                onChange={(event) => setYoutube(event.target.value)}
              />
              <button
                className="primary-button"
                disabled={!validYoutube(youtube) || publish.isPending}
                onClick={() => publish.mutate()}
              >
                Gerar JSON público
              </button>
              {publish.isError && (
                <p role="alert" className="field-error">
                  {publish.error.message}
                </p>
              )}
              {publish.data && (
                <>
                  <p>JSON validado para publicação.</p>
                  <button
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(publish.data, null, 2)], {
                        type: "application/json",
                      });
                      const link = document.createElement("a");
                      link.href = URL.createObjectURL(blob);
                      link.download = "story-publication.json";
                      link.click();
                      URL.revokeObjectURL(link.href);
                    }}
                  >
                    Baixar JSON
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
