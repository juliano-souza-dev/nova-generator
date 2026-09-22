import { AudioLines, Film } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/AsyncState";

export function MediaPage() {
  return (
    <section>
      <PageHeader
        title="Mídia e vozes"
        description="Prepare fontes, acompanhe jobs e selecione perfis de voz locais."
      />
      <div className="two-column">
        <EmptyState title="Fonte de vídeo">
          <Film aria-hidden="true" /> O download e o reaproveitamento global por vídeo do YouTube
          serão habilitados nesta área.
        </EmptyState>
        <EmptyState title="Biblioteca de voz">
          <AudioLines aria-hidden="true" /> Perfis Chatterbox e áudios canônicos estarão disponíveis
          aqui.
        </EmptyState>
      </div>
    </section>
  );
}
