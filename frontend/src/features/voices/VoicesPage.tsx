import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic2, Plus, UploadCloud, Volume2 } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { EmptyState, ErrorState, LoadingState } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import type { VoiceProfile, VoiceReference } from "../../lib/api.types";
import { studioApi } from "../../lib/studio-api";
import "./voices.css";

const VOICE_MODELS = [
  { id: "qwen3-tts-1.7b-voice-design", label: "Qwen3 · Criar voz por descrição" },
  { id: "qwen3-tts-1.7b-base", label: "Qwen3 · Reproduzir voz de referência" },
  { id: "chatterbox-turbo", label: "Chatterbox · Voz de referência (legado)" },
  { id: "chatterbox-nano", label: "Chatterbox · Perfil antigo" },
] as const;

type VoiceModelId = (typeof VOICE_MODELS)[number]["id"];

const DEFAULT_INSTRUCTION =
  "Voz brasileira calorosa, jovem e expressiva, como alguém explicando uma descoberta aos amigos. " +
  "Conversa natural, pausas breves e ênfase nas palavras importantes, sem soar como locução de comercial.";

const schema = z
  .object({
    name: z.string().trim().min(1, "Informe o nome."),
    model_id: z.enum([
      "qwen3-tts-1.7b-voice-design",
      "qwen3-tts-1.7b-base",
      "chatterbox-turbo",
      "chatterbox-nano",
    ]),
    reference_audio_sha256: z.string(),
    instruct: z.string().max(800, "Descreva a voz em até 800 caracteres."),
    reference_text: z.string().max(1000, "A transcrição deve ter até 1000 caracteres."),
  })
  .superRefine((values, ctx) => {
    if (values.model_id === "qwen3-tts-1.7b-voice-design") {
      if (values.instruct.trim().length < 10) {
        ctx.addIssue({
          code: "custom",
          path: ["instruct"],
          message: "Descreva a voz desejada.",
        });
      }
    } else if (!/^[a-f0-9]{64}$/.test(values.reference_audio_sha256)) {
      ctx.addIssue({
        code: "custom",
        path: ["reference_audio_sha256"],
        message: "Selecione um áudio de referência.",
      });
    }
    if (values.model_id === "qwen3-tts-1.7b-base" && !values.reference_text.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["reference_text"],
        message: "Transcreva a fala exata da gravação de referência.",
      });
    }
  });

type FormValues = z.infer<typeof schema>;

function modelLabel(modelId: string): string {
  return VOICE_MODELS.find((model) => model.id === modelId)?.label ?? modelId;
}

function parametersFor(values: FormValues): Record<string, unknown> {
  if (values.model_id === "qwen3-tts-1.7b-voice-design") {
    return { instruct: values.instruct.trim() };
  }
  if (values.model_id === "qwen3-tts-1.7b-base") {
    return { reference_text: values.reference_text.trim() };
  }
  return {};
}

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
        model_id: values.model_id,
        model_sha256: undefined,
        reference_audio_sha256:
          values.model_id === "qwen3-tts-1.7b-voice-design"
            ? undefined
            : values.reference_audio_sha256 || undefined,
        parameters:
          existing &&
          existing.model_id === values.model_id &&
          values.model_id.startsWith("chatterbox-")
            ? existing.parameters
            : parametersFor(values),
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
        description="Narração local com diferentes estilos e vozes versionadas. Suas exportações preservam a voz escolhida."
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
                  v{voice.version} · {modelLabel(voice.model_id)}
                  {voice.reference_ready === false ? " · referência inválida" : ""}
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
                    model_id: selected.model_id as VoiceModelId,
                    reference_audio_sha256: selected.reference_audio_sha256 ?? "",
                    instruct: String(selected.parameters.instruct ?? DEFAULT_INSTRUCTION),
                    reference_text: String(selected.parameters.reference_text ?? ""),
                  },
                  existing: selected,
                })
              }
              busy={mutation.isPending}
              error={mutation.error?.message}
            />
          )}
          <VoiceForm
            onSubmit={(values) => mutation.mutate({ values })}
            selectedVoice={selected}
            onNewVersion={(values, existing) => mutation.mutate({ values, existing })}
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
  error,
}: {
  voice: VoiceProfile;
  onVersion: () => void;
  busy: boolean;
  error?: string;
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
          <dd>{modelLabel(voice.model_id)}</dd>
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
      {voice.reference_ready === false && (
        <p className="field-error" role="alert">
          {voice.reference_message ?? "A referência desta voz precisa ser substituída."} Envie uma
          nova gravação no formulário abaixo e crie uma nova versão deste perfil.
        </p>
      )}
      {voice.preview_ready && voice.preview_url ? (
        <audio controls src={voice.preview_url} aria-label={`Prévia da voz ${voice.name}`} />
      ) : voice.reference_ready === false ? (
        <p role="status">Prévia indisponível até atualizar a referência da voz.</p>
      ) : (
        <p role="status">Prévia em processamento. Acompanhe o estado no monitor de jobs.</p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="secondary-button"
        onClick={onVersion}
        disabled={busy || voice.reference_ready === false}
      >
        <Volume2 />
        {busy ? "Enfileirando…" : "Sintetizar nova versão"}
      </button>
    </section>
  );
}

function VoiceForm({
  onSubmit,
  onNewVersion,
  selectedVoice,
  busy,
  error,
}: {
  onSubmit: (values: FormValues) => void;
  onNewVersion: (values: FormValues, existing: VoiceProfile) => void;
  selectedVoice?: VoiceProfile | null;
  busy: boolean;
  error?: string;
}) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      model_id: "qwen3-tts-1.7b-voice-design",
      reference_audio_sha256: "",
      instruct: DEFAULT_INSTRUCTION,
      reference_text: "",
    },
  });
  const queryClient = useQueryClient();
  const [lastUploaded, setLastUploaded] = useState<VoiceReference | null>(null);
  const references = useQuery({
    queryKey: ["voice-references"],
    queryFn: studioApi.voiceReferences,
  });
  const selectedModel = form.watch("model_id");
  const isVoiceDesign = selectedModel === "qwen3-tts-1.7b-voice-design";
  const isVoiceClone = selectedModel === "qwen3-tts-1.7b-base";
  const model = useQuery({
    queryKey: ["voice-model", selectedModel],
    queryFn: () => studioApi.voiceModel(selectedModel),
  });
  const upload = useMutation({
    mutationFn: studioApi.uploadVoiceReference,
    onSuccess: (reference) => {
      setLastUploaded(reference);
      form.setValue("reference_audio_sha256", reference.sha256, { shouldValidate: true });
      void queryClient.invalidateQueries({ queryKey: ["voice-references"] });
    },
  });
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const dragDepth = useRef(0);

  function submitReference(file: File | undefined) {
    if (!file || upload.isPending) return;
    if (!/\.(wav|mp3|ogg)$/i.test(file.name)) {
      setFileError("Selecione um áudio WAV, MP3 ou OGG.");
      setFileName("");
      return;
    }
    setFileError("");
    setFileName(file.name);
    upload.mutate(file);
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (upload.isPending) return;
    dragDepth.current += 1;
    setIsDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = upload.isPending ? "none" : "copy";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setIsDragging(false);
    if (!upload.isPending) submitReference(event.dataTransfer.files?.[0]);
  }

  // Keep the new option present immediately even while the library query refreshes.
  const availableReferences = [...(references.data ?? [])];
  if (lastUploaded && !availableReferences.some((item) => item.sha256 === lastUploaded.sha256)) {
    availableReferences.push(lastUploaded);
  }
  const currentReference = form.watch("reference_audio_sha256");
  const selectedReference = availableReferences.find(
    (reference) => reference.sha256 === currentReference,
  );
  const referenceTooShort = !!selectedReference && selectedReference.duration_ms < 6000;
  const referenceRequired = !isVoiceDesign;
  const cannotCreate =
    busy ||
    !model.data?.available ||
    upload.isPending ||
    (referenceRequired && (!selectedReference || referenceTooShort)) ||
    (isVoiceDesign && form.watch("instruct").trim().length < 10) ||
    (isVoiceClone && !form.watch("reference_text").trim());
  return (
    <form className="panel voice-form" onSubmit={form.handleSubmit(onSubmit)}>
      <h2>Nova voz ou nova versão</h2>
      <label>
        Nome
        <input {...form.register("name")} placeholder="Narradora Ana" />
      </label>
      <label>
        Tipo de voz
        <select {...form.register("model_id")}>
          {VOICE_MODELS.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      {isVoiceDesign && (
        <label>
          Como a voz deve interpretar a aula?
          <textarea
            rows={4}
            {...form.register("instruct")}
            placeholder="Ex.: voz brasileira envolvente, ritmo natural, curiosidade no início…"
          />
        </label>
      )}
      {isVoiceClone && (
        <label>
          O que está sendo dito na gravação de referência?
          <textarea
            rows={3}
            {...form.register("reference_text")}
            placeholder="Transcreva exatamente a fala do áudio, inclusive pontuação."
          />
          <small>A transcrição ajuda a manter o timbre da mesma pessoa nos quadros.</small>
        </label>
      )}
      <p role="status">
        {model.isPending
          ? "Verificando modelo local…"
          : model.data?.available
            ? "Voz local pronta para gerar prévias."
            : (model.data?.message ?? model.error?.message)}
      </p>
      {!isVoiceDesign && (
        <>
          <div className="voice-upload-field">
            <span className="voice-upload-title">
              Enviar áudio de referência (6 a 30 segundos)
            </span>
            <div
              className={`voice-dropzone${isDragging ? " is-dragging" : ""}${upload.isPending ? " is-uploading" : ""}`}
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              data-testid="voice-reference-dropzone"
            >
              <input
                id="voice-reference-upload"
                aria-label="Enviar áudio de referência (6 a 30 segundos)"
                className="voice-file-input"
                type="file"
                accept=".wav,.mp3,.ogg,audio/wav,audio/x-wav,audio/wave,audio/mpeg,audio/ogg,application/ogg"
                disabled={upload.isPending}
                onChange={(event) => {
                  submitReference(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <label className="voice-dropzone-label" htmlFor="voice-reference-upload">
                <UploadCloud aria-hidden="true" />
                <strong>
                  {isDragging ? "Solte o áudio aqui" : "Arraste seu arquivo de áudio para cá"}
                </strong>
                <span>ou clique aqui para escolher um arquivo</span>
                <small>WAV, MP3 ou OGG · áudio de 6 a 30 segundos</small>
              </label>
            </div>
            {fileName && (
              <p className="voice-upload-filename" role="status">
                {upload.isPending
                  ? "Enviando"
                  : upload.isError
                    ? "Falha ao enviar"
                    : "Arquivo selecionado"}
                : {fileName}
              </p>
            )}
            {fileError && (
              <p className="field-error" role="alert">
                {fileError}
              </p>
            )}
          </div>
          {upload.isPending && <p role="status">Validando áudio…</p>}
          {upload.isError && (
            <p role="alert" className="field-error">
              {upload.error.message}
            </p>
          )}
          <label htmlFor="voice-reference-select">Áudio de referência</label>
          <select
            id="voice-reference-select"
            {...form.register("reference_audio_sha256")}
            value={currentReference}
          >
            <option value="">Selecione um áudio da biblioteca</option>
            {availableReferences.map((reference) => (
              <option
                key={reference.sha256}
                value={reference.sha256}
                disabled={reference.duration_ms < 6000}
              >
                {reference.sha256.slice(0, 12)} · {(reference.duration_ms / 1000).toFixed(1)} s
              </option>
            ))}
          </select>
          {referenceTooShort && (
            <p className="field-error" role="alert">
              Este áudio tem menos de 6 segundos. Escolha uma gravação mais longa.
            </p>
          )}
          {selectedReference && (
            <audio
              controls
              src={selectedReference.audio_url}
              aria-label="Áudio de referência selecionado"
            />
          )}
        </>
      )}
      {Object.values(form.formState.errors).map((value) => (
        <p key={value.message} className="field-error">
          {value.message}
        </p>
      ))}
      {error && <p className="field-error">{error}</p>}
      <button className="primary-button" disabled={cannotCreate}>
        <Plus />
        {busy ? "Criando…" : "Criar e sintetizar prévia"}
      </button>
      {selectedVoice && (
        <button
          type="button"
          className="secondary-button"
          disabled={cannotCreate}
          onClick={() => {
            onNewVersion({ ...form.getValues(), name: selectedVoice.name }, selectedVoice);
          }}
        >
          <Volume2 /> Criar nova versão de {selectedVoice.name}
        </button>
      )}
    </form>
  );
}
