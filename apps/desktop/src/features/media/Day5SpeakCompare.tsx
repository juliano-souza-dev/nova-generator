import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { Check, FileText, LoaderCircle, Upload } from "lucide-react";
import type { SpeakingPrompt } from "./learning-journey-contract";
import "./Day5SpeakCompare.css";

type Cue = { id: string; text: string; startMs: number; endMs: number; words?: { text: string; startMs: number; endMs: number }[] };
type Candidate = SpeakingPrompt & {
  prompt: string; guidancePt: string; successCriteria: string[];
  score?: number; score_breakdown?: Record<string, number>; pedagogical_rationale?: string;
  difficulty?: "beginner" | "elementary" | "intermediate" | "upper-intermediate";
  status?: "draft" | "approved" | "rejected"; include_in_hub?: boolean;
};
type Props = {
  projectId: string; assetId: string; sourceSignature: string; cues: Cue[];
  prompts: SpeakingPrompt[]; onPromptsChange: (prompts: SpeakingPrompt[]) => void;
  onBack: () => void; onSave: () => void; saving: boolean;
};
const INPUT_CONTRACT = "nova-generator-speaking-input/1.0";
const OUTPUT_CONTRACT = "nova-generator-speaking-output/1.0";
const weights = { source_fidelity: 25, speaking_value: 20, clarity: 15, focus_relevance: 15, level_fit: 10, variety: 10, transferability: 5 };
const focuses = ["rhythm", "pauses", "connected-speech", "intonation", "fluency"] as const;
const labels: Record<string, string> = {
  rhythm: "Ritmo", pauses: "Pausas", "connected-speech": "Connected speech",
  intonation: "Entonação", fluency: "Fluência"
};
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const isObject = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim().replace(/\s+/g, " ");

export default function Day5SpeakCompare({ projectId, assetId, sourceSignature, cues, prompts, onPromptsChange, onBack, onSave, saving }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fileName, setFileName] = useState("");
  const sourceCues = useMemo(() => cues.map((cue, index) => ({
    cue_order: index + 1, cue_id: cue.id, start_ms: Math.round(cue.startMs), end_ms: Math.round(cue.endMs),
    text_en: cue.text, words: (cue.words ?? []).map(word => ({
      text: word.text, start_ms: Math.round(word.startMs), end_ms: Math.round(word.endMs)
    }))
  })).filter(cue => cue.text_en.trim() && cue.end_ms > cue.start_ms), [cues]);
  const input = useMemo(() => ({
    contract: INPUT_CONTRACT, project_id: projectId, asset_id: assetId, source_signature: sourceSignature,
    language: { source: "en", support: "pt-BR" }, day: 5, title: "Speak & Compare", source_cues: sourceCues,
    constraints: { audio_is_not_embedded: true, learner_will_play_original_and_record_own_voice: true }
  }), [projectId, assetId, sourceSignature, sourceCues]);

  async function getHash() {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
    return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("");
  }

  async function exportInstructions() {
    if (busy || sourceCues.length < 3) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const hash = await getHash();
      const template = {
        contract: OUTPUT_CONTRACT, source_hash: hash, day: 5,
        prompts: [{
          id: "speak-01", cueOrders: [1], sourceText: "exact excerpt copied from the selected cue",
          translationPt: "natural Brazilian Portuguese meaning",
          focus: "rhythm", prompt: "Listen to the original, record yourself saying the line, then compare both versions.",
          guidancePt: "Observe the timing of the phrase without trying to imitate an accent.",
          successCriteria: ["Manter todas as palavras na ordem correta.", "Aproximar o ritmo da fala original."],
          score: 90, score_breakdown: { source_fidelity: 24, speaking_value: 18, clarity: 14, focus_relevance: 14, level_fit: 8, variety: 8, transferability: 4 },
          pedagogical_rationale: "The phrase offers a useful, manageable opportunity for guided oral practice.",
          difficulty: "beginner"
        }]
      };
      const lines = [
        "NOVA GENERATOR | JORNADA DE APRENDIZAGEM", "DAY 05 · SPEAK & COMPARE",
        "EXTERNAL AI GENERATION PACKAGE | INPUT 1.0",
        "INPUT_CONTRACT: " + INPUT_CONTRACT, "REQUIRED_OUTPUT_CONTRACT: " + OUTPUT_CONTRACT,
        "SOURCE_HASH: " + hash, "PROJECT_ID: " + projectId, "ASSET_ID: " + assetId,
        "SOURCE_SIGNATURE: " + sourceSignature, "",
        "1. MISSÃO PEDAGÓGICA",
        "Crie práticas curtas de produção oral a partir de falas exatas da cena. O aluno deve ouvir a fala original, gravar a própria voz e comparar as duas versões. O objetivo é desenvolver inteligibilidade, ritmo, pausas, connected speech, entonação e fluência, sem exigir imitação de sotaque nativo.",
        "2. SELEÇÃO DOS TRECHOS",
        "Produza preferencialmente 6 a 8 prompts, aceitando de 4 a 10. Cada prompt deve usar exatamente uma cue existente em cueOrders. sourceText deve ser um excerto literal e contínuo da cue. Escolha trechos curtos, pronunciáveis e com valor real para a comunicação. Varie as habilidades quando a fonte permitir; não force uma categoria sem oportunidade adequada.",
        "3. FOCO DE CADA PRÁTICA",
        "focus deve ser exatamente um destes valores: rhythm, pauses, connected-speech, intonation, fluency. rhythm: reproduzir o fluxo e a duração relativa da frase. pauses: perceber e reproduzir agrupamentos e pausas naturais. connected-speech: praticar ligações ou reduções plausíveis na sequência. intonation: orientar o aluno a ouvir e comparar a curva melódica da gravação original, sem afirmar se sobe ou desce quando isso não puder ser comprovado. fluency: dizer a frase com continuidade e sem interrupções artificiais.",
        "4. FIDELIDADE E LIMITES",
        "O pacote contém transcrição e timestamps, não o áudio. Não afirme que ouviu a gravação, não invente sotaque, fonemas, sílabas tônicas, curva de entonação ou pausas acústicas. Você pode propor que o aluno observe esses elementos ao ouvir o áudio original. Não reescreva nem corrija a fala da cena. translationPt deve ser natural em português brasileiro. guidancePt deve orientar a prática de modo objetivo e acolhedor, sem exigir perfeição ou imitação de sotaque.",
        "5. INSTRUÇÃO AO ALUNO",
        "prompt deve explicar uma ação simples: ouvir o original, gravar a própria fala e comparar. successCriteria deve conter de 2 a 4 critérios observáveis e específicos para aquele trecho, sem julgamento subjetivo da voz. Evite instruções genéricas como 'fale perfeitamente'.",
        "6. PONTUAÇÃO",
        "score deve ser número JSON entre 70 e 100. score_breakdown deve conter exatamente estas chaves, sem extras, com valores numéricos dentro dos limites e soma igual a score: " + JSON.stringify(weights) + ".",
        "difficulty deve ser exatamente beginner, elementary, intermediate ou upper-intermediate. Ordene prompts por score decrescente. IDs únicos. Não inclua áudio gravado pelo aluno: a gravação acontece no iHub.",
        "7. SAÍDA",
        "Retorne SOMENTE JSON válido, sem Markdown, comentários ou texto externo. Não inclua outros dias.",
        JSON.stringify(template, null, 2), "", "8. MATERIAL DE ORIGEM", JSON.stringify(input, null, 2)
      ];
      const path = await saveFile({ title: "Salvar instruções do Dia 5", defaultPath: "day-5-speak-compare-" + assetId + ".txt", filters: [{ name: "Instruções para IA externa", extensions: ["txt"] }] });
      if (!path) return;
      await invoke("save_external_translation_package", { path, bytes: Array.from(new TextEncoder().encode("\uFEFF" + lines.join("\r\n"))) });
      setNotice("Instruções do Dia 5 exportadas.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function validatePrompt(raw: any, validOrders: Set<number>): string[] {
    const errors: string[] = [];
    if (!clean(raw?.id) || !clean(raw?.prompt) || !clean(raw?.guidancePt)) errors.push("ID, instrução ou orientação ausente");
    if (!focuses.includes(raw?.focus)) errors.push("focus inválido");
    if (!Array.isArray(raw?.cueOrders) || raw.cueOrders.length !== 1 || !validOrders.has(Number(raw.cueOrders[0]))) errors.push("cueOrders deve apontar para exatamente uma cue válida");
    if (!Array.isArray(raw?.successCriteria) || raw.successCriteria.length < 2 || raw.successCriteria.length > 4 || raw.successCriteria.some((item: unknown) => !clean(item))) errors.push("successCriteria deve conter de 2 a 4 critérios");
    if (!["beginner", "elementary", "intermediate", "upper-intermediate"].includes(raw?.difficulty)) errors.push("difficulty inválido");
    const cue = Array.isArray(raw?.cueOrders) ? sourceCues.find(item => item.cue_order === Number(raw.cueOrders[0])) : undefined;
    const source = normalize(clean(raw?.sourceText));
    if (!cue || !source || !normalize(cue.text_en).includes(source)) errors.push("sourceText não corresponde exatamente à cue");
    const score = raw?.score, breakdown = raw?.score_breakdown, keys = Object.keys(weights);
    if (typeof score !== "number" || score < 70 || score > 100 || !isObject(breakdown) ||
      Object.keys(breakdown).length !== keys.length ||
      keys.some(key => typeof breakdown[key] !== "number" || breakdown[key] < 0 || breakdown[key] > (weights as any)[key]) ||
      keys.reduce((sum, key) => sum + (breakdown[key] ?? 0), 0) !== score) errors.push("score_breakdown inválido: use exatamente as sete chaves e respeite os pesos");
    return errors;
  }

  async function importJson(file?: File) {
    if (!file || busy) return;
    setBusy(true); setError(""); setNotice(""); setFileName(file.name);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("O JSON excede 8 MB.");
      const parsed = JSON.parse(await file.text());
      if (!isObject(parsed) || parsed.contract !== OUTPUT_CONTRACT || parsed.day !== 5 || !Array.isArray(parsed.prompts) || parsed.prompts.length < 4 || parsed.prompts.length > 10) throw new Error("Contrato, dia ou quantidade de práticas inválidos.");
      if (parsed.source_hash !== await getHash()) throw new Error("O JSON foi gerado para outra mídia ou versão da transcrição. Exporte as instruções novamente.");
      for (let i = 1; i < parsed.prompts.length; i++) if (Number(parsed.prompts[i - 1]?.score) < Number(parsed.prompts[i]?.score)) throw new Error("As práticas precisam estar ordenadas da maior para a menor pontuação.");
      const ids = parsed.prompts.map((item: any) => clean(item?.id));
      if (ids.some((id: string) => !id) || new Set(ids).size !== ids.length) throw new Error("Existem IDs ausentes ou duplicados.");
      const validOrders = new Set(sourceCues.map(cue => cue.cue_order));
      const invalid = parsed.prompts.map((prompt: any) => ({ prompt, errors: validatePrompt(prompt, validOrders) })).filter((entry: any) => entry.errors.length);
      if (invalid.length) throw new Error("JSON não aprovado pela validação:\n" + invalid.slice(0, 8).map((entry: any) => entry.prompt?.id + ": " + entry.errors.join(", ")).join("\n"));
      const imported = parsed.prompts.map((prompt: Candidate) => ({ ...prompt, status: "approved" as const }));
      onPromptsChange(imported);
      setNotice(imported.length + " práticas importadas e aprovadas. Você pode rejeitar as que não deseja enviar ao iHub.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  function update(id: string, patch: Partial<Candidate>) {
    onPromptsChange(prompts.map(item => item.id === id ? { ...item, ...patch } as SpeakingPrompt : item));
  }
  const approved = prompts.filter(item => (item as Candidate).status === "approved" && (item as Candidate).include_in_hub !== false);
  return <section className="day5-workspace">
    <header className="day5-header"><div><span>JORNADA DE APRENDIZAGEM · DIA 05</span><h3>Speak & Compare</h3><p>Ouvir, gravar a própria voz e comparar com a fala original.</p></div><button type="button" onClick={onBack}>← Voltar aos dias</button></header>
    <div className="day5-summary">
      <div><strong>{sourceCues.length}</strong><span>trechos disponíveis</span></div>
      <div><strong>{prompts.length}</strong><span>práticas importadas</span></div>
      <div><strong>{approved.length}</strong><span>aprovadas para o iHub</span></div>
      <div><strong>{new Set(approved.map(item => item.focus)).size}/5</strong><span>focos contemplados</span></div>
    </div>
    <div className="day5-actions">
      <button type="button" onClick={() => void exportInstructions()} disabled={busy || sourceCues.length < 3}><FileText size={15}/> Exportar instruções para IA</button>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={15}/> Importar JSON</button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => void importJson(event.target.files?.[0])}/>
      <button type="button" onClick={onSave} disabled={saving || busy}><Check size={15}/>{saving ? "Salvando..." : "Salvar"}</button>
      {busy && <span><LoaderCircle className="day5-spin" size={15}/> Processando...</span>}
    </div>
    {fileName && <small className="day5-file">{fileName}</small>}
    {error && <pre className="day5-error">{error}</pre>}
    {notice && <p className="day5-notice">{notice}</p>}
    <div className="day5-list">
      {!prompts.length ? <div className="day5-empty"><strong>As práticas aparecerão aqui</strong><p>Exporte as instruções, gere o JSON com a IA e importe para revisar.</p></div> :
        prompts.map((item, index) => {
          const prompt = item as Candidate;
          return <article className={"day5-prompt-card" + (prompt.status === "approved" ? " is-approved" : prompt.status === "rejected" ? " is-rejected" : "")} key={item.id}>
            <div className="day5-card-top"><span>#{index + 1} · {labels[item.focus] ?? item.focus}</span><strong>{prompt.score ?? "—"}/100</strong></div>
            <div className="day5-source"><strong>Fala original</strong><p>{item.sourceText}</p>{item.translationPt && <small>{item.translationPt}</small>}</div>
            <label>Instrução ao aluno<textarea value={prompt.prompt ?? ""} onChange={event => update(item.id, { prompt: event.target.value })}/></label>
            <label>Orientação da prática<textarea value={prompt.guidancePt ?? ""} onChange={event => update(item.id, { guidancePt: event.target.value })}/></label>
            <div className="day5-criteria"><strong>O que observar na comparação</strong>{(prompt.successCriteria ?? []).map((criterion, i) => <p key={i}>{criterion}</p>)}</div>
            <div className="day5-review">
              <button type="button" onClick={() => update(item.id, { status: "approved", include_in_hub: true })} disabled={prompt.status === "approved"}>Aprovar</button>
              <button type="button" onClick={() => update(item.id, { status: "rejected", include_in_hub: false })} disabled={prompt.status === "rejected"}>Rejeitar</button>
            </div>
            {prompt.pedagogical_rationale && <small className="day5-rationale">{prompt.pedagogical_rationale}</small>}
          </article>;
        })}
    </div>
    <footer className="day5-footer"><span>{approved.length} de {prompts.length} práticas aprovadas e incluídas</span><button type="button" onClick={onBack}>Voltar aos dias</button><button type="button" onClick={onSave} disabled={saving}>Salvar preparação</button></footer>
  </section>;
}
