import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Copy,
  ExternalLink,
  FolderKanban,
  Plus,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { z } from "zod";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import type { Project } from "../../lib/api.types";
import { studioApi } from "../../lib/studio-api";
import "./projects.css";

const projectSchema = z
  .object({
    title: z.string().trim().max(255),
    content_type: z.enum(["dialogue", "story"]),
    youtube_url: z.union([z.literal(""), z.string().url("Informe uma URL válida.")]),
  })
  .superRefine((value, context) => {
    if (value.content_type === "dialogue" && !value.youtube_url)
      context.addIssue({
        code: "custom",
        path: ["youtube_url"],
        message: "Informe a URL do vídeo.",
      });
    if (value.content_type === "story" && !value.title)
      context.addIssue({
        code: "custom",
        path: ["title"],
        message: "Informe o nome da história.",
      });
  });
type ProjectForm = z.infer<typeof projectSchema>;

export function ProjectsPage() {
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [isCreating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects", search, showArchived],
    queryFn: () => studioApi.projects(search, showArchived),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["projects"] });
  const create = useMutation({
    mutationFn: studioApi.createProject,
    onSuccess: () => {
      void refresh();
      setCreating(false);
    },
  });
  const archive = useMutation({ mutationFn: studioApi.archiveProject, onSuccess: refresh });
  const restore = useMutation({ mutationFn: studioApi.restoreProject, onSuccess: refresh });
  const duplicate = useMutation({ mutationFn: studioApi.duplicateProject, onSuccess: refresh });
  const remove = useMutation({ mutationFn: studioApi.deleteProject, onSuccess: refresh });
  const busy = archive.isPending || restore.isPending || duplicate.isPending || remove.isPending;
  return (
    <section>
      <PageHeader
        title="Projetos"
        description="Organize a fonte de mídia, a revisão editorial e os artefatos de cada produção."
        actions={
          <button className="primary-button" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" /> Novo projeto
          </button>
        }
      />
      {isCreating && (
        <ProjectFormPanel
          busy={create.isPending}
          error={create.error?.message}
          onCancel={() => setCreating(false)}
          onSubmit={(input) =>
            create.mutate({
              ...input,
              title: input.title || undefined,
              youtube_url: input.youtube_url || undefined,
            })
          }
        />
      )}
      <div className="project-toolbar" aria-label="Filtros de projetos">
        <label className="search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">Buscar projetos</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar projeto"
          />
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />{" "}
          Mostrar arquivados
        </label>
      </div>
      {projects.isPending && <LoadingState label="Carregando projetos" />}
      {projects.isError && (
        <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />
      )}
      {projects.data?.length === 0 && (
        <EmptyState title="Nenhum projeto encontrado">
          <FolderKanban aria-hidden="true" /> Crie um projeto ou ajuste a busca.
        </EmptyState>
      )}
      {projects.data && projects.data.length > 0 && (
        <div className="project-grid">
          {projects.data.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              busy={busy}
              onArchive={() => archive.mutate(project.id)}
              onRestore={() => restore.mutate(project.id)}
              onDuplicate={() => duplicate.mutate(project.id)}
              onDelete={() => {
                if (
                  window.confirm(
                    `Excluir “${project.title}”? Esta ação remove o projeto e suas revisões.`,
                  )
                )
                  remove.mutate(project.id);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectFormPanel({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (value: ProjectForm) => void;
}) {
  const form = useForm<ProjectForm>({
    resolver: zodResolver(projectSchema),
    defaultValues: { title: "", content_type: "dialogue", youtube_url: "" },
  });
  const contentType = form.watch("content_type");
  const youtubeUrl = form.watch("youtube_url");
  const inspection = useMutation({ mutationFn: studioApi.inspectYoutubeSource });
  const inspectedCurrentUrl = Boolean(
    inspection.data && youtubeUrl.trim() === inspection.variables?.trim(),
  );
  const submit = form.handleSubmit((value) => {
    if (value.content_type === "dialogue" && !inspectedCurrentUrl) {
      form.setError("youtube_url", { message: "Verifique o vídeo antes de criar o projeto." });
      return;
    }
    onSubmit(value);
  });
  return (
    <form className="panel project-form" onSubmit={submit} noValidate>
      <h2>Novo projeto</h2>
      <label>
        {contentType === "story" ? "Nome da história" : "Título"}{" "}
        {contentType === "dialogue" && <span className="optional">(opcional)</span>}
        <input
          autoFocus
          placeholder={contentType === "dialogue" ? "Use o título do vídeo" : undefined}
          {...form.register("title")}
        />
        {form.formState.errors.title && (
          <span className="field-error">{form.formState.errors.title.message}</span>
        )}
      </label>
      <label>
        Tipo
        <select {...form.register("content_type")}>
          <option value="dialogue">Produção</option>
          <option value="story">História</option>
        </select>
      </label>
      <label>
        URL do YouTube {contentType === "story" && <span className="optional">(opcional)</span>}
        <div className="source-inspection-row">
          <input
            placeholder="https://youtu.be/..."
            {...form.register("youtube_url", { onChange: () => inspection.reset() })}
          />
          {contentType === "dialogue" && (
            <button
              className="secondary-button"
              type="button"
              disabled={!youtubeUrl.trim() || inspection.isPending}
              onClick={() => {
                form.clearErrors("youtube_url");
                inspection.mutate(youtubeUrl, {
                  onError: (failure) => form.setError("youtube_url", { message: failure.message }),
                });
              }}
            >
              {inspection.isPending ? "Verificando…" : "Verificar vídeo"}
            </button>
          )}
        </div>
        {form.formState.errors.youtube_url && (
          <span className="field-error">{form.formState.errors.youtube_url.message}</span>
        )}
      </label>
      {contentType === "dialogue" && inspectedCurrentUrl && inspection.data && (
        <div className="source-inspection-result" role="status">
          <strong>Vídeo encontrado</strong>
          <span>{inspection.data.title}</span>
          {inspection.data.channel && <small>{inspection.data.channel}</small>}
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          className="primary-button"
          type="submit"
          disabled={busy || (contentType === "dialogue" && !inspectedCurrentUrl)}
        >
          {busy ? "Criando…" : "Criar projeto"}
        </button>
        <button className="secondary-button" type="button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function ProjectCard({
  project,
  busy,
  onArchive,
  onRestore,
  onDuplicate,
  onDelete,
}: {
  project: Project;
  busy: boolean;
  onArchive: () => void;
  onRestore: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const cache =
    project.cache_status === "reused"
      ? "Vídeo no cache"
      : project.cache_status === "missing"
        ? "Download pendente"
        : "Sem fonte";
  return (
    <article className={`project-card ${project.archived ? "project-card-archived" : ""}`}>
      <div>
        <span className="project-type">
          {project.content_type === "story" ? "História" : "Produção"}
        </span>
        {project.archived && <span className="project-type">Arquivado</span>}
        <h2>{project.title}</h2>
        <p>
          {project.youtube_video_id
            ? `YouTube: ${project.youtube_video_id}`
            : "Fonte de vídeo ainda não informada"}
        </p>
      </div>
      <div className="project-status">
        <span>{cache}</span>
        <span>Job: {project.job_status}</span>
      </div>
      <div className="project-actions">
        <Link className="secondary-button" to={`/editorial?project=${project.id}`}>
          <ExternalLink aria-hidden="true" /> Abrir
        </Link>
        <button className="secondary-button" onClick={onDuplicate} disabled={busy}>
          <Copy aria-hidden="true" /> Duplicar
        </button>
        {project.archived ? (
          <button className="secondary-button" onClick={onRestore} disabled={busy}>
            <Undo2 aria-hidden="true" /> Restaurar
          </button>
        ) : (
          <button className="secondary-button" onClick={onArchive} disabled={busy}>
            <Archive aria-hidden="true" /> Arquivar
          </button>
        )}
        <button
          className="danger-button"
          onClick={onDelete}
          disabled={busy}
          aria-label={`Excluir ${project.title}`}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
