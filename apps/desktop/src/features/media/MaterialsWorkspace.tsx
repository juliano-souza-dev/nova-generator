import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import {
  AudioLines, BookOpen, Check, CheckCircle2, Download, FileAudio, Layers3,
  LoaderCircle, Plus, RefreshCw, Save, Sparkles, Trash2, Volume2, LockKeyhole
} from "lucide-react";
import "./MaterialsWorkspace.css";

type Asset = { id: string; name: string; kind: string; durationMs?: number | null };
type Cue = { id: string; text: string; startMs: number; endMs: number; speaker?: string };
type Translation = { id: string; text: string };
type SourceType = "editorial" | "shadowing" | "prediction" | "manual";
type AnkiCard = {
  id: string;
  key: string;
  sourceCueId: string;
  sourceType: SourceType;
  type: string;
  focus: string;
  meaning: string;
  highlightEn: string;
  markedEn: string;
  highlightPt: string;
  markedPt: string;
  explanation: string;
  exampleEn: string;
  examplePt: string;
  speaker: string;
  audioText: string;
  audioPath?: string;
  status: "draft" | "approved";
};
type MaterialDocument = { version: 2; cards: AnkiCard[]; updatedAt: string; sourceSignature: string };
type AudioResult = { cardId: string; audioPath: string; sampleRate: number; language: string; speaker: string };

const createCardId = () => crypto.randomUUID();
const newCard = (): AnkiCard => {
  const id = createCardId();
  return {
    id, key: "anki-" + id, sourceCueId: "", sourceType: "manual", type: "expression",
    focus: "", meaning: "", highlightEn: "", markedEn: "", highlightPt: "", markedPt: "",
    explanation: "", exampleEn: "", examplePt: "", speaker: "", audioText: "", status: "draft"
  };
};
const text = (value: unknown) => typeof value === "string" ? value : "";
const normalizeStoredCard = (raw: any): AnkiCard => {
  const id = text(raw?.id) || createCardId();
  const focus = text(raw?.focus) || text(raw?.front);
  const meaning = text(raw?.meaning) || text(raw?.back);
  const highlightEn = text(raw?.highlightEn) || text(raw?.expression);
  const highlightPt = text(raw?.highlightPt);
  return {
    id, key: text(raw?.key) || "anki-" + id,
    sourceCueId: text(raw?.sourceCueId), sourceType: raw?.sourceType || "manual",
    type: text(raw?.type) || "expression", focus, meaning,
    highlightEn, markedEn: text(raw?.markedEn) || highlightEn,
    highlightPt, markedPt: text(raw?.markedPt) || highlightPt,
    explanation: text(raw?.explanation),
    exampleEn: text(raw?.exampleEn),
    examplePt: text(raw?.examplePt),
    speaker: text(raw?.speaker),
    audioText: text(raw?.audioText) || focus,
    audioPath: text(raw?.audioPath) || undefined,
    status: raw?.status === "approved" ? "approved" : "draft"
  };
};
const cardFromSuggestion = (item: any, cue: Cue, translation?: Translation): AnkiCard => {
  const focus = text(item.approved_en) || cue.text;
  const highlightEn = text(item.highlight_en) || text(item.highlightEn) || text(item.expression) || text(item.highlighted_expression);
  const highlightPt = text(item.highlight_pt) || text(item.highlightPt) || text(item.expression_pt);
  const example = Array.isArray(item.examples) ? item.examples[0] : null;
  return {
    id: createCardId(), key: "anki-" + cue.id + "-" + createCardId(), sourceCueId: cue.id, sourceType: "editorial",
    type: text(item.type) || "expression", focus,
    meaning: text(item.meaning) || text(item.approved_pt) || text(translation?.text),
    highlightEn, markedEn: text(item.marked) || text(item.marked_en) || highlightEn,
    highlightPt, markedPt: text(item.marked_pt) || text(item.markedPt) || highlightPt,
    explanation: text(item.mini_lesson) || text(item.explanation) || text(item.analysis),
    exampleEn: text(item.example_en) || text(item.exampleEn) || text(example?.en),
    examplePt: text(item.example_pt) || text(item.examplePt) || text(example?.pt),
    speaker: text(cue.speaker), audioText: focus, status: "draft"
  };
};
const cardFromPrediction = (item: any): AnkiCard => {
  const id = createCardId();
  const focus = text(item.prompt);
  const answer = text(item.answerText);
  return {
    id, key: "anki-" + (text(item.cueId) || "prediction") + "-" + id,
    sourceCueId: text(item.cueId), sourceType: "prediction", type: "listening",
    focus, meaning: answer, highlightEn: text(item.highlightedText) || focus,
    markedEn: text(item.markedEn) || text(item.highlightedText) || focus,
    highlightPt: answer, markedPt: answer, explanation: text(item.explanation),
    exampleEn: text(item.exampleEn), examplePt: text(item.examplePt),
    speaker: "", audioText: answer || focus, status: "draft"
  };
};
const cardFromShadowing = (cue: Cue, translation?: Translation): AnkiCard => {
  const meaning = text(translation?.text);
  return {
    id: createCardId(), key: "anki-" + cue.id + "-" + createCardId(), sourceCueId: cue.id,
    sourceType: "shadowing", type: "shadowing", focus: cue.text, meaning,
    highlightEn: cue.text, markedEn: cue.text, highlightPt: meaning, markedPt: meaning,
    explanation: "Trecho selecionado e concluído no Shadowing.",
    exampleEn: "", examplePt: "", speaker: text((cue as any).speaker), audioText: cue.text, status: "draft"
  };
};

export default function MaterialsWorkspace({ projectId, onProjectUpdated }: { projectId: string; onProjectUpdated?: () => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState("");
  const [cards, setCards] = useState<AnkiCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [audioBusy, setAudioBusy] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [predictionSaved, setPredictionSaved] = useState(false);
  const [ttsReady, setTtsReady] = useState(false);
  const [sourceInfo, setSourceInfo] = useState({ cues: 0, translations: 0, editorial: 0, shadowing: 0, predictions: 0 });
  const [sourceSignature, setSourceSignature] = useState("");

  const selectedAsset = useMemo(() => assets.find(item => item.id === assetId), [assets, assetId]);
  const approvedCards = useMemo(() => cards.filter(card => card.status === "approved"), [cards]);
  const approvedCount = approvedCards.length;
  const pendingAudioCount = approvedCards.filter(card => !card.audioPath).length;
  const refreshAssets = useCallback(async () => {
    const items = await invoke<Asset[]>("list_project_media", { projectId });
    const videos = items.filter(item => item.kind === "video");
    setAssets(videos);
    setAssetId(current => current && videos.some(item => item.id === current) ? current : videos[0]?.id ?? "");
  }, [projectId]);

  const loadSource = useCallback(async (selectedId: string) => {
    if (!selectedId) {
      setCards([]);
      setPredictionSaved(false);
      setSourceInfo({ cues: 0, translations: 0, editorial: 0, shadowing: 0, predictions: 0 });
      return;
    }
    setLoading(true); setError(""); setNotice("");
    try {
      const [cues, translations, prediction, stored] = await Promise.all([
        invoke<Cue[]>("load_project_subtitles", { projectId, assetId: selectedId }),
        invoke<Translation[]>("load_project_translations", { projectId, assetId: selectedId }).catch(() => [] as Translation[]),
        invoke<any>("load_prediction_listening_result", { projectId, assetId: selectedId }).catch(() => null),
        invoke<MaterialDocument | null>("load_project_materials", { projectId, assetId: selectedId }).catch(() => null)
      ]);
      const editorial = await invoke<any>("load_project_editorial_result", { projectId, assetId: selectedId, cues }).catch(() => null);
      const signature = JSON.stringify([
        cues.map(c => [c.id, c.startMs, c.endMs, c.text]),
        translations.map(t => [t.id, t.text]),
        editorial?.suggestions?.map((item: any) => [item.cue_id, item.approved_en, item.approved_pt]) ?? []
      ]);
      const shadowing = await invoke<{ selectedCueIds: string[]; sourceSignature: string } | null>(
        "load_shadowing_selection", { projectId, assetId: selectedId, cues, sourceSignature: signature }
      ).catch(() => null);
      const shadowingIds = shadowing?.sourceSignature === signature ? shadowing.selectedCueIds : [];
      const isPredictionSaved = Boolean(prediction?.saved_at);
      setPredictionSaved(isPredictionSaved);
      setSourceSignature(signature);
      setSourceInfo({
        cues: cues.length,
        translations: translations.length,
        editorial: editorial?.suggestions?.length ?? 0,
        shadowing: shadowingIds.length,
        predictions: Array.isArray(prediction?.challenges) ? prediction.challenges.filter((item: any) => item.status === "approved").length : 0
      });

      if ((stored?.version === 1 || stored?.version === 2) && Array.isArray(stored.cards)) {
        setCards(stored.cards.map(normalizeStoredCard));
        if (stored.sourceSignature !== signature) setNotice("As fontes do projeto mudaram. Seus cards salvos foram preservados para revisão.");
      } else {
        const translationById = new Map(translations.map(item => [item.id, item]));
        const suggestions = Array.isArray(editorial?.suggestions) ? editorial.suggestions : [];
        const editorialCards = suggestions.flatMap((item: any) => {
          const cue = cues.find(candidate => candidate.id === (item.cue_id ?? item.cueId));
          if (!cue) return [];
          const card = cardFromSuggestion(item, cue, translationById.get(cue.id));
          return card.focus.trim() && card.meaning.trim() ? [card] : [];
        });
        const shadowingCards = shadowingIds.flatMap(id => {
          const cue = cues.find(candidate => candidate.id === id);
          if (!cue) return [];
          const card = cardFromShadowing(cue, translationById.get(cue.id));
          return card.focus.trim() && card.meaning.trim() ? [card] : [];
        });
        const predictionCards = isPredictionSaved && Array.isArray(prediction?.challenges)
          ? prediction.challenges.filter((item: any) => item.status === "approved").map(cardFromPrediction)
            .filter((card: AnkiCard) => card.focus.trim() && card.meaning.trim())
          : [];
        setCards([...editorialCards, ...shadowingCards, ...predictionCards]);
      }
    } catch (e) {
      setError(String(e)); setCards([]); setPredictionSaved(false);
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void refreshAssets().catch(e => setError(String(e))); }, [refreshAssets]);
  useEffect(() => { if (assetId) void loadSource(assetId); else setLoading(false); }, [assetId, loadSource]);
  useEffect(() => {
    invoke<any>("get_shared_runtime_status")
      .then(status => setTtsReady(Boolean(status?.qwen3TtsReady)))
      .catch(() => setTtsReady(false));
  }, []);

  function updateCard(id: string, patch: Partial<AnkiCard>) {
    setCards(current => current.map(card => {
      if (card.id !== id) return card;
      const audioTextChanged = patch.focus !== undefined || patch.audioText !== undefined;
      return {
        ...card,
        ...patch,
        audioPath: audioTextChanged ? undefined : (patch.audioPath ?? card.audioPath),
        status: patch.status ?? (Object.keys(patch).some(key => key !== "audioPath") ? "draft" : card.status)
      };
    }));
  }

  async function persistMaterials() {
    if (!assetId) throw new Error("Selecione uma mídia de origem.");
    const document: MaterialDocument = { version: 2, cards, updatedAt: new Date().toISOString(), sourceSignature };
    await invoke("save_project_materials", { projectId, assetId, materials: document });
    await invoke("update_project_stage", { id: projectId, stage: "Materiais" }).catch(() => undefined);
    onProjectUpdated?.();
    return document;
  }

  async function saveMaterials() {
    if (!assetId || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await persistMaterials();
      setNotice("Materiais salvos neste projeto. Cards, revisões e vínculos de áudio foram preservados.");
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }

  async function generateAudio(card: AnkiCard) {
    if (!assetId || !ttsReady || audioBusy.includes(card.id)) return;
    const audioText = card.audioText.trim() || card.focus.trim();
    if (!audioText) { setError("Preencha o texto para áudio antes de gerar."); return; }
    setAudioBusy(current => [...current, card.id]); setError(""); setNotice("");
    try {
      const result = await invoke<AudioResult[]>("generate_material_audio", {
        projectId, assetId, requests: [{ cardId: card.id, text: audioText, language: "English", speaker: "Aiden" }]
      });
      const audio = result[0];
      if (!audio?.audioPath) throw new Error("O sintetizador não retornou o arquivo de áudio.");
      setCards(current => current.map(item => item.id === card.id ? { ...item, audioPath: audio.audioPath } : item));
      setNotice("Áudio gerado para o card. Salve os Materiais para registrar o vínculo no projeto.");
    } catch (e) { setError(String(e)); }
    finally { setAudioBusy(current => current.filter(id => id !== card.id)); }
  }

  async function generatePendingAudio() {
    const pending = approvedCards.filter(card => !card.audioPath);
    if (!assetId || !ttsReady || !pending.length || audioBusy.length) return;
    const invalid = pending.find(card => !(card.audioText.trim() || card.focus.trim()));
    if (invalid) { setError("O card " + invalid.id + " não possui texto para sintetização."); return; }
    setAudioBusy(pending.map(card => card.id)); setError(""); setNotice("");
    try {
      const result = await invoke<AudioResult[]>("generate_material_audio", {
        projectId, assetId,
        requests: pending.map(card => ({
          cardId: card.id, text: card.audioText.trim() || card.focus.trim(), language: "English", speaker: "Aiden"
        }))
      });
      const byId = new Map(result.map(item => [item.cardId, item.audioPath]));
      setCards(current => current.map(card => byId.has(card.id) ? { ...card, audioPath: byId.get(card.id) } : card));
      setNotice(result.length + " áudio(s) gerado(s). Salve os Materiais para registrar os vínculos.");
    } catch (e) { setError(String(e)); }
    finally { setAudioBusy([]); }
  }

  async function exportPackage() {
    if (!assetId || exporting || !approvedCount) return;
    if (pendingAudioCount) { setError("Gere o áudio de todos os cards aprovados antes de exportar o pacote Anki."); return; }
    setError(""); setNotice("");
    try {
      const path = await saveFile({
        title: "Exportar pacote de Materiais",
        defaultPath: "materiais-" + assetId + ".zip",
        filters: [{ name: "Pacote de Materiais", extensions: ["zip"] }]
      });
      if (!path) return;
      setExporting(true);
      await persistMaterials();
      await invoke("export_project_materials_package", { projectId, assetId, outputPath: path });
      setNotice("Pacote exportado com Anki (.apkg), JSON e áudios.");
    } catch (e) { setError(String(e)); }
    finally { setExporting(false); }
  }

  function exportJson() {
    const payload = JSON.stringify({ schema: "nova-generator-materials/1.0", projectId, assetId, assetName: selectedAsset?.name, cards }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "materiais-" + assetId + ".json"; anchor.click();
    URL.revokeObjectURL(url);
  }

  return <section className="materials-workspace">
    <header className="materials-heading">
      <div><span className="eyebrow">ESTÚDIO DIDÁTICO</span><h2>Materiais</h2><p>Reúna conteúdos aprovados, prepare cards Anki e gere os áudios usados no estudo.</p></div>
      <div className="materials-heading-actions">
        <button className="secondary-button" onClick={exportJson} disabled={!cards.length}><Download size={15}/> Exportar JSON</button>
        <button className="secondary-button" onClick={() => void generatePendingAudio()} disabled={!ttsReady || !pendingAudioCount || !approvedCount || Boolean(audioBusy.length)}><AudioLines size={15}/>{audioBusy.length ? "Gerando áudios..." : "Gerar áudios pendentes"}</button>
        <button className="primary-button" onClick={() => void saveMaterials()} disabled={!assetId || saving}><Save size={15}/>{saving ? "Salvando..." : "Salvar materiais"}</button>
        <button className="primary-button" onClick={() => void exportPackage()} disabled={!assetId || exporting || !approvedCount || pendingAudioCount > 0}><Download size={15}/>{exporting ? "Exportando..." : "Exportar pacote Anki"}</button>
      </div>
    </header>

    {error && <div className="materials-alert error">{error}</div>}
    {notice && <div className="materials-alert success"><CheckCircle2 size={15}/>{notice}</div>}

    {!assets.length ? <div className="materials-empty"><div><Layers3 size={25}/></div><h3>Adicione uma mídia para começar</h3><p>A área Materiais usa transcrições, traduções e conteúdos aprovados vinculados aos vídeos do projeto.</p></div> : <>
      <div className="materials-source">
        <div><span className="eyebrow">CONTEÚDO DE ORIGEM</span><strong>{selectedAsset?.name ?? "Selecione um vídeo"}</strong><small>Os materiais são organizados por vídeo e permanecem vinculados ao projeto.</small></div>
        <select value={assetId} onChange={event => setAssetId(event.target.value)} aria-label="Vídeo de origem">{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>
      </div>

      {loading ? <div className="materials-loading"><LoaderCircle className="spin" size={20}/> Carregando fontes do projeto...</div> : !predictionSaved ? <div className="materials-gate">
        <div><LockKeyhole size={23}/></div>
        <h3>Materiais ainda não liberados</h3>
        <p>Para liberar esta área, abra o editor da mídia, entre em Prediction Listening e clique em <strong>Salvar e liberar Materiais</strong>. Importar o JSON ou aprovar desafios, isoladamente, não libera a etapa.</p>
      </div> : <>
        <div className="materials-stats">
          <div><BookOpen size={17}/><strong>{sourceInfo.cues}</strong><span>trechos</span></div>
          <div><Volume2 size={17}/><strong>{sourceInfo.translations}</strong><span>traduções</span></div>
          <div><Sparkles size={17}/><strong>{sourceInfo.editorial}</strong><span>sugestões editoriais</span></div>
          <div><AudioLines size={17}/><strong>{sourceInfo.shadowing}</strong><span>trechos Shadowing</span></div>
          <div><CheckCircle2 size={17}/><strong>{sourceInfo.predictions}</strong><span>desafios aprovados</span></div>
        </div>

        <div className="materials-runtime">
          <div className="materials-runtime-icon"><AudioLines size={18}/></div>
          <div><strong>Qwen3-TTS 1.7B · voz em inglês</strong><p>{ttsReady ? "Runtime compartilhado pronto. A geração usa o ambiente isolado do Shared Runtime Manager." : "Runtime não disponível. Sincronize o Nova Generator e instale qwen3-tts pelo Shared Runtime Manager."}</p></div>
          <span className={ttsReady ? "ready" : "missing"}>{ttsReady ? "Disponível" : "Não instalado"}</span>
        </div>

        <div className="materials-section-title">
          <div><span className="eyebrow">GERADOR 01</span><h3>Cards Anki</h3><p>Conteúdo editorial, Shadowing e Prediction Listening. Revise cada card antes de incluí-lo no pacote.</p></div>
          <div className="materials-card-count">{approvedCount} de {cards.length} aprovados · {pendingAudioCount} áudio(s) pendente(s)</div>
        </div>

        {loading ? <div className="materials-loading"><LoaderCircle className="spin" size={20}/> Carregando conteúdo do projeto...</div> : <>
          {!cards.length && <div className="materials-empty compact"><div><BookOpen size={22}/></div><h3>Nenhum card preparado</h3><p>Não encontramos conteúdos com frente e verso. Você pode criar os cards manualmente.</p></div>}
          <div className="materials-card-list">{cards.map((card, index) => <article className="materials-card" key={card.id}>
            <div className="materials-card-top">
              <div><span className="materials-card-number">CARD {String(index + 1).padStart(2, "0")}</span><span className={"materials-source-tag " + card.sourceType}>{card.sourceType === "prediction" ? "PREDICTION LISTENING" : card.sourceType === "shadowing" ? "SHADOWING" : card.sourceType === "editorial" ? "EDITORIAL" : "MANUAL"}</span><span className={card.status === "approved" ? "materials-status approved" : "materials-status"}>{card.status === "approved" ? "Aprovado" : "Rascunho"}</span></div>
              <button className="materials-icon-button" title="Excluir card" onClick={() => setCards(current => current.filter(item => item.id !== card.id))}><Trash2 size={15}/></button>
            </div>
            <div className="materials-card-fields">
              <label>Frase em inglês (frente) <textarea value={card.focus} onChange={e => updateCard(card.id, { focus: e.target.value })} placeholder="Frase completa em inglês"/></label>
              <label>Expressão destacada (EN) <input value={card.highlightEn} onChange={e => updateCard(card.id, { highlightEn: e.target.value })} placeholder="Ex.: figure out"/></label>
              <label>Trecho exato destacado (EN) <input value={card.markedEn} onChange={e => updateCard(card.id, { markedEn: e.target.value })} placeholder="Texto exato dentro da frase"/></label>
              <label>Tradução / significado (PT) <textarea value={card.meaning} onChange={e => updateCard(card.id, { meaning: e.target.value })} placeholder="Tradução contextual da frase ou expressão"/></label>
              <label>Destaque (PT) <input value={card.highlightPt} onChange={e => updateCard(card.id, { highlightPt: e.target.value })} placeholder="Equivalente em português"/></label>
              <label>Trecho exato destacado (PT) <input value={card.markedPt} onChange={e => updateCard(card.id, { markedPt: e.target.value })} placeholder="Texto exato dentro da tradução"/></label>
              <label>Tipo do card <input value={card.type} onChange={e => updateCard(card.id, { type: e.target.value })} placeholder="EXPRESSION, PHRASAL VERB, STRUCTURE..."/></label>
              <label>Mini-aula / explicação contextual <textarea value={card.explanation} onChange={e => updateCard(card.id, { explanation: e.target.value })} placeholder="Como entender e usar esta expressão no contexto"/></label>
              <label>Outro exemplo (EN) <textarea value={card.exampleEn} onChange={e => updateCard(card.id, { exampleEn: e.target.value })} placeholder="Exemplo adicional em inglês"/></label>
              <label>Outro exemplo (PT) <textarea value={card.examplePt} onChange={e => updateCard(card.id, { examplePt: e.target.value })} placeholder="Tradução do exemplo"/></label>
              <label>Texto para áudio <input value={card.audioText} onChange={e => updateCard(card.id, { audioText: e.target.value })} placeholder="Texto em inglês que será narrado"/></label>
            </div>
            <div className="materials-audio-row">
              {card.audioPath ? <audio controls preload="none" src={convertFileSrc(card.audioPath)}/> : <span><FileAudio size={15}/> Nenhum áudio gerado</span>}
              <button className="secondary-button" onClick={() => void generateAudio(card)} disabled={!ttsReady || audioBusy.length > 0 || !card.audioText.trim() && !card.focus.trim()}>
                {audioBusy.includes(card.id) ? <LoaderCircle className="spin" size={14}/> : card.audioPath ? <RefreshCw size={14}/> : <AudioLines size={14}/>}
                {audioBusy.includes(card.id) ? "Gerando..." : card.audioPath ? "Regenerar áudio" : "Gerar áudio"}
              </button>
            </div>
            <footer className="materials-card-footer">
              <span>{card.sourceCueId ? "Vinculado à transcrição" : "Card manual"}</span>
              <button className={card.status === "approved" ? "materials-approve approved" : "materials-approve"} onClick={() => updateCard(card.id, { status: card.status === "approved" ? "draft" : "approved" })} disabled={card.status !== "approved" && (!card.focus.trim() || !card.meaning.trim())}>
                {card.status === "approved" ? <Check size={14}/> : <CheckCircle2 size={14}/>} {card.status === "approved" ? "Reabrir revisão" : "Aprovar card"}
              </button>
            </footer>
          </article>)}</div>
          <button className="materials-add-card" onClick={() => setCards(current => [...current, newCard()])}><Plus size={16}/> Adicionar card manual</button>
        </>}
        <div className="materials-next">
          <div className="materials-next-icon"><FileAudio size={19}/></div>
          <div><strong>Pacote de estudo</strong><p>O ZIP final reúne o pacote Anki (.apkg), o JSON editável e os áudios dos cards aprovados.</p></div>
          <span>{approvedCount > 0 && pendingAudioCount === 0 ? <CheckCircle2 size={15}/> : <RefreshCw size={15}/>} {approvedCount > 0 && pendingAudioCount === 0 ? "Pronto para exportar" : "Aguardando revisão e áudios"}</span>
        </div>
      </>}
    </>}
  </section>;
}
