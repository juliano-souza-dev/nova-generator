import { FileArchive } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/AsyncState";

export function StoryPage() {
  return (
    <section>
      <PageHeader
        title="Modo História"
        description="Produção independente a partir de um ZIP com story.json e imagens."
      />
      <EmptyState title="Envie o pacote da história">
        <FileArchive aria-hidden="true" /> A validação do ZIP, escolha de voz e renderização serão
        adicionadas nesta área.
      </EmptyState>
    </section>
  );
}
