import { useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Download, FileText, Upload } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import "./Day1Preparation.css";

type Cue = { id: string; text: string; startMs: number; endMs: number; words?: { text: string; startMs: number; endMs: number }[] };
type PracticeItem = {
  id: string; cueOrder: number; expression: string; meaningPt: string;
  explanationPt?: string; exampleEn?: string; examplePt?: string;
  score: number; status: "approved" | "rejected";
};
export type Day1PreparationData = {
  subtitleChallenge: { cueOrders: number[] };
  expressionMatch: PracticeItem[];
  patternChallenge: PracticeItem[];
  sourceHash: string;
};
type Props = {
  projectId: string; assetId: string; sourceSignature: string; cues: Cue[];
  cards: { id: string; sourceCueId: string; focus: string; meaning: string; highlightEn: string; explanation: string; exampleEn: string; examplePt: string; status: string }[];
  value?: Day1PreparationData | null; onChange: (value: Day1PreparationData) => void;
  onBack: () => void; onSave: () => void; saving: boolean;
};
const CONTRACT = "nova-generator-day1-practice-output/1.0";
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const isObject = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export default function Day1Preparation({ projectId, assetId, sourceSignature, cues, cards, value, onChange, onBack, onSave, saving }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const source = useMemo(() => ({
    contract: "nova-generator-day1-practice-input/1.0", project_id: projectId, asset_id: assetId,
    source_signature: sourceSignature,
    source_cues: cues.map((cue, index) => ({ cue_order: index + 1, cue_id: cue.id, start_ms: Math.round(cue.startMs), end_ms: Math.round(cue.endMs), text_en: cue.text, words: cue.words || [] })),
    approved_material_cards: cards.filter(card => card.status === "approved" && cues.some(cue => cue.id === card.sourceCueId)).map(card => ({
      id: card.id, cue_order: cues.findIndex(cue => cue.id === card.sourceCueId) + 1,
      expression: card.highlightEn || card.focus, meaning_pt: card.meaning,
      explanation_pt: card.explanation, example_en: card.exampleEn, example_pt: card.examplePt
    }))
  }), [projectId, assetId, sourceSignature, cues, cards]);

  async function exportInstructions() {
    setBusy(true); setError(""); setNotice("");
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source)));
      const sourceHash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
      const schema = {
        contract: CONTRACT, source_hash: sourceHash,
        subtitleChallenge: { cueOrders: [1, 2, 3] },
        expressionMatch: [{ id: "expression-01", cueOrder: 1, expression: "exact expression from source", meaningPt: "meaning in Brazilian Portuguese", score: 90 }],
        patternChallenge: [{ id: "pattern-01", cueOrder: 1, expression: "reusable structure from source", meaningPt: "meaning and use", explanationPt: "clear explanation", exampleEn: "new example", examplePt: "translation", score: 90 }]
      };
      const instructions = [
        "NOVA GENERATOR | DAY 1 · PRACTICE ACTIVITIES", "EXTERNAL AI INSTRUCTIONS | VERSION 1.0",
        "OUTPUT CONTRACT: " + CONTRACT, "SOURCE HASH: " + sourceHash, "",
        "MISSION: Prepare the Practice activities for Day 1 using only the supplied video transcript and approved pedagogical material cards.",
        "SUBTITLE CHALLENGE: select at least 3 and at most 12 cueOrders containing complete, meaningful English subtitle lines. Do not rewrite, translate, or create lines. The iHub game rebuilds the original subtitle from its words, so return only the cue order references.",
        "EXPRESSION MATCH: select 3 to 12 useful expressions that actually occur in the source cues. Each item must include its exact cueOrder, expression, and concise pt-BR meaning. Prefer approved material cards when relevant. Do not invent expressions.",
        "PATTERN CHALLENGE: select 5 to 12 reusable structures that occur in the source cues. Each item must include exact cueOrder, expression, meaningPt, explanationPt, and one natural new example in English with pt-BR translation. Use only structures genuinely supported by the source. Do not duplicate expressions.",
        "QUALITY: prioritize everyday communicative value, beginner accessibility, source fidelity, and distinct items. Never invent source cue text or timestamps. Return fewer items only if the source cannot support the minimum; if a game cannot be supported, return an empty array for that game.",
        "SCORING: score each expressionMatch and patternChallenge item from 70 to 100. Provide an integer score. Sort each list from highest to lowest score.",
        "OUTPUT: Return ONLY valid JSON matching the exact schema below. No Markdown, comments, or extra properties.",
        "OUTPUT SHAPE", JSON.stringify(schema, null, 2), "", "SOURCE MATERIAL", JSON.stringify(source, null, 2)
      ].join("\r\n");
      const path = await save({ title: "Salvar instruções do Practice · Dia 1", defaultPath: "day-1-practice-" + assetId + ".txt", filters: [{ name: "Arquivo de texto", extensions: ["txt"] }] });
      if (!path) return;
      await invoke("save_external_translation_package", { path, bytes: Array.from(new TextEncoder().encode("\uFEFF" + instructions)) });
      setNotice("Instruções do Practice exportadas. Envie o TXT à IA externa e importe o JSON.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function importJson(file?: File) {
    if (!file || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("O JSON excede 5 MB.");
      const parsed = JSON.parse(await file.text());
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source)));
      const sourceHash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (!isObject(parsed) || parsed.contract !== CONTRACT || parsed.source_hash !== sourceHash) throw new Error("Contrato ou origem incompatível. Gere novamente o TXT para esta mídia.");
      const cueOrderValid = (n: unknown) => Number.isInteger(n) && Number(n) >= 1 && Number(n) <= cues.length;
      const subtitleCueOrders = Array.isArray(parsed.subtitleChallenge?.cueOrders) ? parsed.subtitleChallenge.cueOrders : [];
      if (subtitleCueOrders.length < 3 || subtitleCueOrders.length > 12 || subtitleCueOrders.some((n: unknown) => !cueOrderValid(n)) || new Set(subtitleCueOrders).size !== subtitleCueOrders.length) throw new Error("Subtitle Challenge precisa de 3 a 12 cueOrders únicos e válidos.");
      const validateItems = (items: any, type: "expression" | "pattern") => {
        const min = type === "expression" ? 3 : 5;
        if (!Array.isArray(items)) throw new Error(type + " precisa ser uma lista.");
        if (items.length > 12 || (items.length > 0 && items.length < min)) throw new Error(type + " precisa conter ao menos " + min + " itens, quando houver material suficiente, e no máximo 12.");
        const ids = new Set<string>(); const expressions = new Set<string>();
        return items.map((item: any, index: number) => {
          if (!isObject(item) || !clean(item.id) || ids.has(item.id)) throw new Error("ID ausente ou duplicado em " + type + ".");
          ids.add(item.id);
          if (!cueOrderValid(item.cueOrder)) throw new Error("cueOrder inválido em " + type + ".");
          const cue = cues[Number(item.cueOrder) - 1];
          const expression = clean(item.expression);
          if (!expression || !cue.text.toLocaleLowerCase().includes(expression.toLocaleLowerCase())) throw new Error("A expressão de " + type + " não existe literalmente no trecho de origem.");
          const key = expression.toLocaleLowerCase();
          if (expressions.has(key)) throw new Error("Expressão duplicada em " + type + ".");
          expressions.add(key);
          const score = Number(item.score);
          if (!Number.isInteger(score) || score < 70 || score > 100) throw new Error("Pontuação inválida em " + type + ".");
          if (!clean(item.meaningPt)) throw new Error("meaningPt ausente em " + type + ".");
          if (type === "pattern" && (!clean(item.explanationPt) || !clean(item.exampleEn) || !clean(item.examplePt))) throw new Error("Pattern Challenge exige explicação e exemplo bilíngue.");
          return { id: item.id, cueOrder: Number(item.cueOrder), expression, meaningPt: clean(item.meaningPt), explanationPt: clean(item.explanationPt), exampleEn: clean(item.exampleEn), examplePt: clean(item.examplePt), score, status: "approved" as const };
        }).sort((a: PracticeItem, b: PracticeItem) => b.score - a.score);
      };
      const expressionMatch = validateItems(parsed.expressionMatch, "expression");
      const patternChallenge = validateItems(parsed.patternChallenge, "pattern");
      onChange({ sourceHash, subtitleChallenge: { cueOrders: subtitleCueOrders.map(Number) }, expressionMatch, patternChallenge });
      setNotice("JSON importado e validado. Os itens importados foram aprovados para o pacote final.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  }

  const sections = [
    { title: "Subtitle Challenge", detail: value?.subtitleChallenge.cueOrders.length ? value.subtitleChallenge.cueOrders.length + " trechos selecionados" : "A IA selecionará legendas completas do vídeo." },
    { title: "Expression Match", detail: value?.expressionMatch.length ? value.expressionMatch.length + " expressões aprovadas" : "Associa expressões reais aos seus significados." },
    { title: "Pattern Challenge", detail: value?.patternChallenge.length ? value.patternChallenge.length + " estruturas aprovadas" : "Trabalha padrões reutilizáveis em novos exemplos." }
  ];
  return <section className="day1-practice">
    <header><div><span className="eyebrow">DIA 01 · PRACTICE</span><h3>Atividades de prática</h3><p>Os jogos usam o vídeo e a transcrição já preparados no editor. Esta etapa seleciona e organiza o conteúdo pedagógico, sem alterar legendas ou tempos.</p></div></header>
    <div className="day1-practice-grid">{sections.map(item => <article key={item.title}><strong>{item.title}</strong><span>{item.detail}</span></article>)}</div>
    <div className="day1-practice-actions">
      <button className="secondary-button" type="button" onClick={() => void exportInstructions()} disabled={busy || !cues.length}><FileText size={15}/> Preparar TXT para IA</button>
      <button className="secondary-button" type="button" onClick={() => inputRef.current?.click()} disabled={busy}><Upload size={15}/> Importar JSON</button>
      <input ref={inputRef} type="file" accept=".json,application/json" hidden onChange={event => void importJson(event.target.files?.[0])}/>
    </div>
    {error && <p role="alert" className="day1-practice-error">{error}</p>}
    {notice && <p role="status" className="day1-practice-notice">{notice}</p>}
    <footer><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={14}/> Voltar aos dias</button><button type="button" className="primary-button" onClick={onSave} disabled={saving}>Salvar Dia 1</button></footer>
  </section>;
}
