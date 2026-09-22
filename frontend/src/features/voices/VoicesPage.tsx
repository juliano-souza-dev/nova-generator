import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic2, Plus, Volume2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import type { VoiceProfile } from "../../lib/api.types";
import { studioApi } from "../../lib/studio-api";
import "./voices.css";

const schema = z.object({
  name: z.string().trim().min(1, "Informe o nome."),
  reference_audio_sha256: z.string().regex(/^[a-f0-9]{64}$/, "Selecione um WAV de referência."),
});
type FormValues = z.infer<typeof schema>;

export function VoicesPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const voices = useQuery({
    queryKey: ["voices"],
    queryFn: studioApi.voices,
    refetchInterval: 5000,
  });
  const selected = voices.data?.find((voice) => voice.id === selectedId) ?? null;
  const mutation = useMutation({
    mutationFn: ({ values, existing }: { values: FormValues; existing?: VoiceProfile }) => {
      const input = {
        name: values.name,
        model_id: "chatterbox-nano",
        model_sha256: existing?.model_sha256,
        reference_audio_sha256: values.reference_audio_sha256 || undefined,
        parameters: {},
      };
      return existing
        ? studioApi.createVoiceVersion(existing.id, input)
        : studioApi.createVoice(input);
    },
    onSuccess: (voice) => {
      setSelectedId(voice.id);
      void queryClient.invalidateQueries({ queryKey: ["voices"] });
    },
  });
  return (
    <section>
      <PageHeader
        title="Biblioteca de vozes"
        description="Perfis Chatterbox versionados. Exportações guardam um snapshot e nunca mudam de voz."
      />
      <div className="voices-layout">
        <div className="voice-list panel">
          <h2>Perfis disponíveis</h2>
          {voices.isPending && <LoadingState label="Carregando vozes" />}
          {voices.isError && (
            <ErrorState message={voices.error.message} retry={() => void voices.refetch()} />
          )}
          {voices.data?.length === 0 && (
            <EmptyState title="Nenhuma voz sintetizada">
              <Mic2 /> Crie o primeiro perfil local.
            </EmptyState>
          )}
          {voices.data?.map((voice) => (
            <button
              key={voice.id}
              className={`voice-row ${selected?.id === voice.id ? "selected" : ""}`}
              onClick={() => setSelectedId(voice.id)}
            >
              <Mic2 aria-hidden="true" />
              <span>
                {voice.name}
                <small>
                  v{voice.version} · {voice.model_id}
                </small>
              </span>
            </button>
          ))}
        </div>
        <div className="voice-workspace">
          {selected && (
            <VoiceDetail
              voice={selected}
              onVersion={() =>
                mutation.mutate({
                  values: {
                    name: selected.name,
                    reference_audio_sha256: selected.reference_audio_sha256 ?? "",
                  },
                  existing: selected,
                })
              }
              busy={mutation.isPending}
            />
          )}
          <VoiceForm
            onSubmit={(values) => mutation.mutate({ values })}
            busy={mutation.isPending}
            error={mutation.error?.message}
          />
        </div>
      </div>
    </section>
  );
}

function VoiceDetail({
  voice,
  onVersion,
  busy,
}: {
  voice: VoiceProfile;
  onVersion: () => void;
  busy: boolean;
}) {
  return (
    <section className="panel voice-detail">
      <h2>{voice.name}</h2>
      <p>
        Versão ativa: <strong>v{voice.version}</strong>
      </p>
      <dl>
        <div>
          <dt>Modelo</dt>
          <dd>{voice.model_id}</dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd className="hash">{voice.snapshot_sha256}</dd>
        </div>
        <div>
          <dt>Referência</dt>
          <dd>
            {voice.reference_audio_sha256
              ? voice.reference_audio_sha256.slice(0, 12)
              : "Sem referência"}
          </dd>
        </div>
      </dl>
      {voice.preview_ready && voice.preview_url ? (
        <audio controls src={voice.preview_url} aria-label={`Prévia da voz ${voice.name}`} />
      ) : (
        <p role="status">Prévia em processamento. Acompanhe o estado no monitor de jobs.</p>
      )}
      <button className="secondary-button" onClick={onVersion} disabled={busy}>
        <Volume2 />
        {busy ? "Enfileirando…" : "Sintetizar nova versão"}
      </button>
    </section>
  );
}

function VoiceForm({
  onSubmit,
  busy,
  error,
}: {
  onSubmit: (values: FormValues) => void;
  busy: boolean;
  error?: string;
}) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", reference_audio_sha256: "" },
  });
  const queryClient = useQueryClient();
  const references = useQuery({
    queryKey: ["voice-references"],
    queryFn: studioApi.voiceReferences,
  });
  const model = useQuery({ queryKey: ["voice-model"], queryFn: studioApi.voiceModel });
  const upload = useMutation({
    mutationFn: studioApi.uploadVoiceReference,
    onSuccess: (reference) => {
      form.setValue("reference_audio_sha256", reference.sha256, { shouldValidate: true });
      void queryClient.invalidateQueries({ queryKey: ["voice-references"] });
    },
  });
  const selectedReference = references.data?.find(
    (reference) => reference.sha256 === form.watch("reference_audio_sha256"),
  );
  return (
    <form className="panel voice-form" onSubmit={form.handleSubmit(onSubmit)}>
      <h2>Nova voz</h2>
      <label>
        Nome
        <input {...form.register("name")} placeholder="Narradora Ana" />
      </label>
      <p role="status">
        {model.isPending
          ? "Verificando modelo local…"
          : model.data?.available
            ? "Modelo Chatterbox Nano disponível."
            : (model.data?.message ?? model.error?.message)}
      </p>
      <label htmlFor="voice-reference-upload">Enviar WAV de referência (1 a 30 segundos)</label>
      <input
        id="voice-reference-upload"
        type="file"
        accept=".wav,audio/wav"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) upload.mutate(file);
        }}
      />
      {upload.isPending && <p>Validando áudio…</p>}
      {upload.isError && (
        <p role="alert" className="field-error">
          {upload.error.message}
        </p>
      )}
      <label htmlFor="voice-reference-select">Áudio de referência</label>
      <select id="voice-reference-select" {...form.register("reference_audio_sha256")}>
        <option value="">Selecione um WAV da biblioteca</option>
        {references.data?.map((reference) => (
          <option key={reference.sha256} value={reference.sha256}>
            {reference.sha256.slice(0, 12)} · {(reference.duration_ms / 1000).toFixed(1)} s
          </option>
        ))}
      </select>
      {selectedReference && (
        <audio
          controls
          src={selectedReference.audio_url}
          aria-label="Áudio de referência selecionado"
        />
      )}
      {Object.values(form.formState.errors).map((value) => (
        <p key={value.message} className="field-error">
          {value.message}
        </p>
      ))}
      {error && <p className="field-error">{error}</p>}
      <button
        className="primary-button"
        disabled={busy || !model.data?.available || upload.isPending}
      >
        <Plus />
        {busy ? "Criando…" : "Criar e sintetizar prévia"}
      </button>
    </form>
  );
}
