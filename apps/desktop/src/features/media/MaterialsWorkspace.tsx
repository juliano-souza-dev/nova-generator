import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AudioLines, BookOpen, Check, CheckCircle2, Download, FileAudio, Layers3, LoaderCircle, Plus, RefreshCw, Save, Sparkles, Trash2, Volume2 } from "lucide-react";
import "./MaterialsWorkspace.css";

type Asset = { id: string; name: string; kind: string; durationMs?: number | null };
type Cue = { id: string; text: string; startMs: number; endMs: number };
type Translation = { id: string; text: string };
type AnkiCard = { id: string; sourceCueId: string; front: string; back: string; expression: string; explanation: string; examples: string; audioText: string; status: "draft" | "approved" };
type MaterialDocument = { version: 1; cards: AnkiCard[]; updatedAt: string; sourceSignature: string };

const newCard = (): AnkiCard => ({ id: crypto.randomUUID(), sourceCueId: "", front: "", back: "", expression: "", explanation: "", examples: "", audioText: "", status: "draft" });
const text = (value: unknown) => typeof value === "string" ? value : "";
const cardFromSuggestion = (item: any, cue: Cue, translation?: Translation): AnkiCard => ({
 id: crypto.randomUUID(), sourceCueId: cue.id,
 front: text(item.approved_en) || cue.text,
 back: text(item.approved_pt) || text(translation?.text),
 expression: text(item.expression) || text(item.highlighted_expression),
 explanation: text(item.mini_lesson) || text(item.explanation),
 examples: Array.isArray(item.examples) ? item.examples.map((example: any) => [text(example.en), text(example.pt)].filter(Boolean).join(" / ")).join("\n") : "",
 audioText: text(item.approved_en) || cue.text, status: "draft"
});

export default function MaterialsWorkspace({ projectId, onProjectUpdated }: { projectId: string; onProjectUpdated?: () => void }) {
 const [assets, setAssets] = useState<Asset[]>([]);
 const [assetId, setAssetId] = useState("");
 const [cards, setCards] = useState<AnkiCard[]>([]);
 const [loading, setLoading] = useState(true);
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState("");
 const [notice, setNotice] = useState("");
 const [sourceInfo, setSourceInfo] = useState({ cues: 0, translations: 0, editorial: 0, predictions: 0 });
 const [sourceSignature, setSourceSignature] = useState("");

 const selectedAsset = useMemo(() => assets.find(item => item.id === assetId), [assets, assetId]);
 const approvedCount = cards.filter(card => card.status === "approved").length;
 const refreshAssets = useCallback(async () => {
  const items = await invoke<Asset[]>("list_project_media", { projectId });
  const videos = items.filter(item => item.kind === "video");
  setAssets(videos);
  setAssetId(current => current && videos.some(item => item.id === current) ? current : videos[0]?.id ?? "");
 }, [projectId]);

 const loadSource = useCallback(async (selectedId: string) => {
  if (!selectedId) { setCards([]); setSourceInfo({ cues: 0, translations: 0, editorial: 0, predictions: 0 }); return; }
  setLoading(true); setError(""); setNotice("");
  try {
   const [cues, translations, prediction, stored] = await Promise.all([
    invoke<Cue[]>("load_project_subtitles", { projectId, assetId: selectedId }),
    invoke<Translation[]>("load_project_translations", { projectId, assetId: selectedId }).catch(() => [] as Translation[]),
    invoke<any>("load_prediction_listening_result", { projectId, assetId: selectedId }).catch(() => null),
    invoke<MaterialDocument | null>("load_project_materials", { projectId, assetId: selectedId }).catch(() => null)
   ]);
   const editorial = await invoke<any>("load_project_editorial_result", { projectId, assetId: selectedId, cues }).catch(() => null);
   const signature = JSON.stringify([cues.map(c => [c.id, c.text]), translations.map(t => [t.id, t.text]), editorial?.approval, editorial?.suggestions?.length ?? 0]);
   setSourceSignature(signature);
   setSourceInfo({ cues: cues.length, translations: translations.length, editorial: editorial?.suggestions?.length ?? 0, predictions: Array.isArray(prediction?.challenges) ? prediction.challenges.length : 0 });
   if (stored?.version === 1 && Array.isArray(stored.cards)) {
    setCards(stored.cards);
   } else {
    const translationById = new Map(translations.map(item => [item.id, item]));
    const suggestions = Array.isArray(editorial?.suggestions) ? editorial.suggestions : [];
    const generated = suggestions.flatMap((item: any) => {
     const cue = cues.find(candidate => candidate.id === (item.cue_id ?? item.cueId));
     if (!cue) return [];
     const card = cardFromSuggestion(item, cue, translationById.get(cue.id));
     return card.front.trim() && card.back.trim() ? [card] : [];
    });
    setCards(generated);
   }
  } catch (e) { setError(String(e)); setCards([]); }
  finally { setLoading(false); }
 }, [projectId]);

 useEffect(() => { void refreshAssets().catch(e => setError(String(e))); }, [refreshAssets]);
 useEffect(() => { if (assetId) void loadSource(assetId); }, [assetId, loadSource]);

 function updateCard(id: string, patch: Partial<AnkiCard>) {
  setCards(current => current.map(card => card.id === id ? { ...card, ...patch, status: patch.status ?? "draft" } : card));
 }
 async function save() {
  if (!assetId || saving) return;
  setSaving(true); setError(""); setNotice("");
  try {
   const document: MaterialDocument = { version: 1, cards, updatedAt: new Date().toISOString(), sourceSignature };
   await invoke("save_project_materials", { projectId, assetId, materials: document });
   await invoke("update_project_stage", { id: projectId, stage: "Materiais" }).catch(() => undefined);
   setNotice("Materiais salvos neste projeto."); onProjectUpdated?.();
  } catch (e) { setError(String(e)); }
  finally { setSaving(false); }
 }
 function exportJson() {
  const payload = JSON.stringify({ schema: "nova-generator-materials/1.0", projectId, assetId, cards }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "materiais-" + assetId + ".json"; anchor.click(); URL.revokeObjectURL(url);
 }

 return <section className="materials-workspace">
  <header className="materials-heading">
   <div><span className="eyebrow">ESTÚDIO DIDÁTICO</span><h2>Materiais</h2><p>Transforme o conteúdo aprovado em cards e recursos de estudo.</p></div>
   <div className="materials-heading-actions"><button className="secondary-button" onClick={exportJson} disabled={!cards.length}><Download size={15}/> Exportar JSON</button><button className="primary-button" onClick={() => void save()} disabled={!assetId || saving}><Save size={15}/>{saving ? "Salvando..." : "Salvar materiais"}</button></div>
  </header>
  {error && <div className="materials-alert error">{error}</div>}
  {notice && <div className="materials-alert success"><CheckCircle2 size={15}/>{notice}</div>}
  {!assets.length ? <div className="materials-empty"><div><Layers3 size={25}/></div><h3>Adicione uma mídia para começar</h3><p>A área Materiais usa as transcrições e traduções salvas nos vídeos do projeto. Importe um vídeo na aba Mídias e conclua a preparação editorial.</p></div> : <>
   <div className="materials-source">
    <div><span className="eyebrow">CONTEÚDO DE ORIGEM</span><strong>{selectedAsset?.name ?? "Selecione um vídeo"}</strong><small>Os materiais são organizados por vídeo e permanecem vinculados ao projeto.</small></div>
    <select value={assetId} onChange={event => setAssetId(event.target.value)} aria-label="Vídeo de origem">{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>
   </div>
   <div className="materials-stats">
    <div><BookOpen size={17}/><strong>{sourceInfo.cues}</strong><span>trechos</span></div>
    <div><LanguagesIcon/><strong>{sourceInfo.translations}</strong><span>traduções</span></div>
    <div><Sparkles size={17}/><strong>{sourceInfo.editorial}</strong><span>sugestões editoriais</span></div>
    <div><AudioLines size={17}/><strong>{sourceInfo.predictions}</strong><span>desafios de listening</span></div>
   </div>
   <div className="materials-section-title"><div><span className="eyebrow">GERADOR 01</span><h3>Cards Anki</h3><p>Frente, verso, expressão, explicação, exemplos e texto associado ao áudio.</p></div><div className="materials-card-count">{approvedCount} de {cards.length} aprovados</div></div>
   {loading ? <div className="materials-loading"><LoaderCircle className="spin" size={20}/> Carregando conteúdo do projeto...</div> : <>
    {!cards.length && <div className="materials-empty compact"><div><BookOpen size={22}/></div><h3>Nenhum card preparado</h3><p>Não encontramos sugestões editoriais com frente e verso. Você pode criar os cards manualmente.</p></div>}
    <div className="materials-card-list">{cards.map((card, index) => <article className="materials-card" key={card.id}>
     <div className="materials-card-top"><div><span className="materials-card-number">CARD {String(index + 1).padStart(2, "0")}</span><span className={card.status === "approved" ? "materials-status approved" : "materials-status"}>{card.status === "approved" ? "Aprovado" : "Rascunho"}</span></div><button className="materials-icon-button" title="Excluir card" onClick={() => setCards(current => current.filter(item => item.id !== card.id))}><Trash2 size={15}/></button></div>
     <div className="materials-card-fields">
      <label>Frente <textarea value={card.front} onChange={e => updateCard(card.id, { front: e.target.value })} placeholder="Expressão ou frase em inglês"/></label>
      <label>Verso <textarea value={card.back} onChange={e => updateCard(card.id, { back: e.target.value })} placeholder="Tradução ou significado em português"/></label>
      <label>Expressão em destaque <input value={card.expression} onChange={e => updateCard(card.id, { expression: e.target.value })} placeholder="Ex.: figure out"/></label>
      <label>Mini-aula / explicação <textarea value={card.explanation} onChange={e => updateCard(card.id, { explanation: e.target.value })} placeholder="Explique o uso e o contexto da expressão"/></label>
      <label>Exemplos bilíngues <textarea value={card.examples} onChange={e => updateCard(card.id, { examples: e.target.value })} placeholder={"English example / Exemplo em português"} /></label>
      <label>Texto para áudio <input value={card.audioText} onChange={e => updateCard(card.id, { audioText: e.target.value })} placeholder="Texto que será narrado"/></label>
     </div>
     <footer className="materials-card-footer"><span>{card.sourceCueId ? "Vinculado à transcrição" : "Card manual"}</span><button className={card.status === "approved" ? "materials-approve approved" : "materials-approve"} onClick={() => updateCard(card.id, { status: card.status === "approved" ? "draft" : "approved" })}>{card.status === "approved" ? <Check size={14}/> : <CheckCircle2 size={14}/>} {card.status === "approved" ? "Reabrir revisão" : "Aprovar card"}</button></footer>
    </article>)}</div>
    <button className="materials-add-card" onClick={() => setCards(current => [...current, newCard()])}><Plus size={16}/> Adicionar card</button>
   </>}
   <div className="materials-next">
    <div className="materials-next-icon"><FileAudio size={19}/></div><div><strong>Próxima etapa: geração de áudios</strong><p>Os textos aprovados já ficam organizados para receber a geração e a revisão individual dos arquivos de áudio.</p></div><span><RefreshCw size={15}/> Em preparação</span>
   </div>
  </>}
 </section>;
}

function LanguagesIcon() { return <Volume2 size={17}/>; }
