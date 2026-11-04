import { useQuery } from "@tanstack/react-query";
import { Download, Film, FolderOpen, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { mediaApi, type MediaLibraryVideo } from "../tiktok-media/tiktok-api";
import "./library.css";

const formats: Record<string, string> = {
  carousel: "Carrossel",
  lesson_video: "Mini-aula",
  lyrics_video: "Música",
  shadowing_video: "Shadowing",
};

function duration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function timestamp(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function LibraryCard({ video }: { video: MediaLibraryVideo }) {
  const videoUrl = mediaApi.videoUrl(video.project_id, video.render_id);
  return (
    <article className="library-card panel">
      <div className="library-video">
        <video controls preload="metadata" src={videoUrl} aria-label={"Assistir " + video.title}>
          Seu navegador não consegue reproduzir este vídeo.
        </video>
      </div>
      <div className="library-card-content">
        <span className="library-tag">{formats[video.format] ?? "Vídeo"}</span>
        <h2 title={video.title}>{video.title}</h2>
        <p className="library-meta">
          {timestamp(video.completed_at)} · {duration(video.duration_ms)} ·{" "}
          {(video.size_bytes / (1024 * 1024)).toFixed(1)} MB
        </p>
        <div className="library-actions">
          <a
            className="primary-button"
            href={mediaApi.videoDownloadUrl(video.project_id, video.render_id)}
            download
          >
            <Download aria-hidden="true" /> Baixar MP4
          </a>
          <Link
            className="secondary-button"
            to={"/tiktok-media?project=" + encodeURIComponent(video.project_id)}
          >
            <FolderOpen aria-hidden="true" /> Abrir produção
          </Link>
        </div>
      </div>
    </article>
  );
}

export function LibraryPage() {
  const [search, setSearch] = useState("");
  const library = useQuery({
    queryKey: ["tiktok-video-library"],
    queryFn: mediaApi.library,
    refetchInterval: 15000,
  });
  const videos = (library.data ?? []).filter((video) =>
    video.title.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR")),
  );

  return (
    <section className="library-page">
      <PageHeader
        title="Biblioteca"
        description="Seus vídeos finalizados ficam aqui, mesmo depois que você sai da edição."
        actions={
          <button
            className="secondary-button"
            type="button"
            onClick={() => void library.refetch()}
            disabled={library.isFetching}
          >
            <RefreshCw aria-hidden="true" /> Atualizar
          </button>
        }
      />
      <div className="library-toolbar">
        <label className="library-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Buscar vídeos</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar vídeo pelo título"
          />
        </label>
        <span>{library.data?.length ?? 0} vídeos finalizados</span>
      </div>
      {library.isPending && <LoadingState label="Carregando biblioteca" />}
      {library.isError && (
        <ErrorState message={library.error.message} retry={() => void library.refetch()} />
      )}
      {library.isSuccess && videos.length === 0 && (
        <EmptyState title={search ? "Nenhum vídeo com esse título" : "Sua biblioteca está vazia"}>
          {search ? (
            "Tente outra busca."
          ) : (
            <>
              <Film aria-hidden="true" /> Os vídeos do TikTok Mídia aparecerão aqui após a
              exportação.
              <Link to="/tiktok-media">Criar vídeo</Link>
            </>
          )}
        </EmptyState>
      )}
      {videos.length > 0 && (
        <div className="library-grid">
          {videos.map((video) => (
            <LibraryCard key={video.render_id} video={video} />
          ))}
        </div>
      )}
    </section>
  );
}
