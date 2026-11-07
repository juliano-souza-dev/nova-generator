import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, Pencil, Play, Plus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { mediaApi, type MediaSoundEffect } from "./tiktok-api";
import "./tiktok-media.css";

export function SoundEffectsLibraryPage() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState("");
  const effects = useQuery({ queryKey: ["tiktok-sound-effects"], queryFn: mediaApi.soundEffects });
  const upload = useMutation({
    mutationFn: (file: File) => mediaApi.addSoundEffect(name.trim() || file.name.replace(/\\.[^.]+$/, ""), file),
    onSuccess: async () => {
      setName("");
      if (inputRef.current) inputRef.current.value = "";
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["tiktok-sound-effects"] });
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "Não foi possível importar o áudio."),
  });
  const rename = useMutation({
    mutationFn: () => mediaApi.renameSoundEffect(renameId!, renameValue),
    onSuccess: async () => {
      setRenameId(null);
      await queryClient.invalidateQueries({ queryKey: ["tiktok-sound-effects"] });
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "Não foi possível renomear."),
  });
  const remove = useMutation({
    mutationFn: mediaApi.deleteSoundEffect,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tiktok-sound-effects"] }),
    onError: (reason) => setError(reason instanceof Error ? reason.message : "Não foi possível excluir."),
  });

  return (
    <section className="tm-page tm-sound-library">
      <PageHeader
        title="Biblioteca de efeitos sonoros"
        description="Cadastre sons uma única vez e reutilize-os nos Motion Graphics de qualquer projeto."
        actions={<button className="tm-accent" onClick={() => inputRef.current?.click()}><Upload size={16} /> Importar áudio</button>}
      />
      <div className="tm-card tm-sound-upload">
        <div>
          <h2><AudioLines size={18} /> Novo efeito sonoro</h2>
          <p className="tm-small">MP3, WAV ou OGG. Até 50 MiB por arquivo.</p>
        </div>
        <label className="tm-field">
          <span>Nome do efeito</span>
          <input value={name} maxLength={80} placeholder="Ex.: Check, Pop suave, Resposta correta" onChange={(event) => setName(event.target.value)} />
        </label>
        <input ref={inputRef} type="file" accept=".mp3,.wav,.ogg,audio/*" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) upload.mutate(file);
        }} />
        <button className="tm-accent" onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
          <Plus size={16} /> {upload.isPending ? "Importando…" : "Escolher arquivo"}
        </button>
        {error && <p role="alert" className="tm-sound-error">{error}</p>}
      </div>
      <div className="tm-sound-list" aria-live="polite">
        {effects.isLoading && <p className="tm-small">Carregando biblioteca…</p>}
        {effects.data?.length === 0 && <p className="tm-small">Sua biblioteca ainda está vazia. Importe o primeiro efeito sonoro.</p>}
        {effects.data?.map((effect) => (
          <article className="tm-card tm-sound-item" key={effect.id}>
            <div className="tm-sound-item-title"><AudioLines size={19} /><div><strong>{effect.name}</strong><small>{effect.filename.split(".").pop()?.toUpperCase()} · {(effect.size_bytes / 1024 / 1024).toFixed(2)} MiB</small></div></div>
            <audio controls preload="none" src={mediaApi.soundEffectUrl(effect.id)} />
            {renameId === effect.id ? (
              <div className="tm-sound-rename">
                <input aria-label="Novo nome do efeito" value={renameValue} maxLength={80} onChange={(event) => setRenameValue(event.target.value)} />
                <button onClick={() => rename.mutate()} disabled={!renameValue.trim() || rename.isPending}>Salvar</button>
                <button onClick={() => setRenameId(null)}>Cancelar</button>
              </div>
            ) : (
              <div className="tm-sound-actions">
                <button aria-label={`Renomear ${effect.name}`} onClick={() => { setRenameId(effect.id); setRenameValue(effect.name); }}><Pencil size={15} /> Renomear</button>
                <button aria-label={`Excluir ${effect.name}`} onClick={() => { if (window.confirm(`Excluir o efeito "${effect.name}" da biblioteca?`)) remove.mutate(effect.id); }}><Trash2 size={15} /> Excluir</button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
