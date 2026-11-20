import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { Check, FileText, LoaderCircle, Upload } from "lucide-react";
import type { MicroLesson } from "./learning-journey-contract";
import "./Day3NoticeInContext.css";

type Cue = { id: string; text: string; startMs: number; endMs: number; words?: { text: string; startMs: number; endMs: number }[] };
type Card = { id: string; sourceCueId: string; focus: string; meaning: string; highlightEn: string; explanation: string; exampleEn: string; examplePt: string; status: string };
type SmartLesson = { final_selection?: string | null; candidates?: { id: string; lesson: { title: string; meaning_pt: string; communicative_intent_pt: string; explanation_pt: string; examples: { en: string; pt: string }[]; context_tree: unknown[] }; source: { cue_order: number; expression: string; excerpt_en: string; excerpt_pt: string } }[] };
type Lesson = MicroLesson & { score?: number; score_breakdown?: Record<string, number>; pedagogical_rationale?: string; status?: "draft" | "approved" | "rejected"; include_in_hub?: boolean; sourceText?: string; communicativeIntentPt?: string; contextTree?: { id: string; title: string; purpose: string; examples: { en: string; pt: string }[] }[] };
type Props = {
  projectId: string; assetId: string; sourceSignature: string; cues: Cue[];
  cards: Card[]; smartLearningMoments: SmartLesson | null; lessons: MicroLesson[];
  onLessonsChange: (lessons: MicroLesson[]) => void; onBack: () => void; onSave: () => void; saving: boolean;
};
const CONTRACT = "nova-generator-notice-in-context-output/1.0";
const INPUT = "nova-generator-notice-in-context-input/1.0";
const weights = { contextual_meaning: 20, communicative_value: 20, transferability: 15, source_fidelity: 15, instructional_clarity: 10, level_fit: 10, practice_quality: 10 };
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const isObject = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export default function Day3NoticeInContext({ projectId, assetId, sourceSignature, cues, cards, smartLearningMoments, lessons, onLessonsChange, onBack, onSave, saving }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fileName, setFileName] = useState("");
  const selectedMoment = smartLearningMoments?.candidates?.find(item => item.id === smartLearningMoments.final_selection) ?? null;
  const approvedCards = useMemo(() => cards.filter(card => card.status === "approved" && cues.some(cue => cue.id === card.sourceCueId)), [cards, cues]);
  const source = useMemo(() => ({
    contract: INPUT, project_id: projectId, asset_id: assetId, source_signature: sourceSignature,
    source_cues: cues.map((cue, index) => ({ cue_order: index + 1, cue_id: cue.id, start_ms: Math.round(cue.startMs), end_ms: Math.round(cue.endMs), text_en: cue.text, words: cue.words ?? [] })),
    approved_material_cards: approvedCards.map(card => ({ id: card.id, cue_order: cues.findIndex(cue => cue.id === card.sourceCueId) + 1, expression: card.highlightEn || card.focus, meaning_pt: card.meaning, explanation_pt: card.explanation, example_en: card.exampleEn, example_pt: card.examplePt })),
    selected_smart_learning_moment: selectedMoment ? { id: selectedMoment.id, lesson: selectedMoment.lesson, source: selectedMoment.source } : null,
    rules: { target_level: "beginner", language_support: "pt-BR", expected_candidates: "4-8", minimum_score: 70, score_weights: weights }
  }), [projectId, assetId, sourceSignature, cues, approvedCards, selectedMoment]);

  async function exportInstructions() {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source)));
      const sourceHash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
      const schema = {
        contract: CONTRACT, source_hash: sourceHash, day: 3, lessons: [{
          id: "notice-01", title: "string", focus: "expression | grammar | connected-speech | pronunciation | pragmatics",
          sourceCueOrders: [1], sourceText: "exact excerpt from source cue", targetEn: "expression or structure",
          targetPt: "contextual meaning in Brazilian Portuguese", communicativeIntentPt: "what the speaker is doing with this expression",
          explanationPt: "short teaching explanation", examples: [{ en: "natural example", pt: "Brazilian Portuguese translation" }],
          contextTree: [{ id: "context-1", title: "situation", purpose: "when to use it", examples: [{ en: "example", pt: "translation" }] }],
          practice: { prompt: "contextual choice", options: [{ id: "correct", text: "..." }, { id: "distractor", text: "..." }], answerId: "correct", feedbackPt: "explain why" },
          score: 90, score_breakdown: { contextual_meaning: 18, communicative_value: 18, transferability: 14, source_fidelity: 14, instructional_clarity: 9, level_fit: 9, practice_quality: 8 }, pedagogical_rationale: "specific evidence", difficulty: "beginner"
        }]
      };
      const instructions = [
        "NOVA GENERATOR | DAY 3 · NOTICE IN CONTEXT", "EXTERNAL AI INSTRUCTIONS | VERSION 1.0",
        "OUTPUT CONTRACT: " + CONTRACT, "SOURCE HASH: " + sourceHash, "",
        "MISSION: Create 4 to 8 concise contextual micro-lessons from the supplied transcript cues, prioritizing the approved material cards and selected Smart Learning Moment when present. If neither exists, identify strong teaching opportunities directly in the transcript. The purpose is noticing: help the learner see how English communicates meaning in this exact situation, not merely memorize a translation.",
        "PRIORITY: If selected_smart_learning_moment exists, use it as the central anchor and preserve its teaching insight, expression, source cue, and communicative intent. Build complementary lessons only when they teach distinct insights. Do not duplicate the same expression or lesson. Approved material cards are trusted candidate sources, not a quota. If no approved cards or selected moment are supplied, inspect the transcript cues and select only expressions or structures with clear contextual teaching value. Do not invent source speech.",
        "TEACHING FLOW: (1) show the exact original excerpt and target expression; (2) explain what the speaker means in this scene; (3) name the communicative intention (requesting, suggesting, softening, reacting, disagreeing, etc.); (4) explain the reusable pattern; (5) show at least two natural examples in different situations with pt-BR translations; (6) provide at least two context-tree branches that demonstrate transfer; (7) finish with one short contextual choice question and explanatory feedback.",
        "SOURCE FIDELITY: sourceCueOrders must refer to supplied one-based cue_order values. sourceText must be an exact excerpt from the referenced cue. Never invent source speech or timestamps. targetEn must occur in sourceText. Keep examples outside the source clearly marked as new examples. No audio/acoustic claims: this day teaches meaning and usage, not sound recognition.",
        "QUALITY: beginner-friendly, concise, useful in everyday communication, no literal-translation-only lessons, no grammar jargon without explanation. Prefer fewer strong lessons over padding. Return 4-8 only if supported by source material.",
        "RANKING: score each candidate from 70 to 100 using exactly these score_breakdown keys and maximum weights: " + JSON.stringify(weights) + ". Values must be JSON numbers within each maximum and sum exactly to score. Sort score descending. difficulty must be exactly beginner, elementary, intermediate, or upper-intermediate. Include pedagogical_rationale with concrete evidence.",
        "OUTPUT: Return ONLY valid JSON. Use the exact field names and structure below. Do not add markdown or commentary. The human editor will approve/reject each lesson; do not set final approval.",
        "OUTPUT SHAPE", JSON.stringify(schema, null, 2), "", "SOURCE MATERIAL", JSON.stringify(source, null, 2)
      ].join("\r\n");
      const path = await saveFile({ title: "Salvar instruções do Dia 3", defaultPath: "day-3-notice-in-context-" + assetId + ".txt", filters: [{ name: "Instruções para IA externa", extensions: ["txt"] }] });
      if (!path) return;
      await invoke("save_external_translation_package", { path, bytes: Array.from(new TextEncoder().encode("\uFEFF" + instructions)) });
      setNotice("Instruções do Dia 3 exportadas com fonte, materiais aprovados e mini aula selecionada.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function importJson(file?: File) {
    if (!file || busy) return;
    setBusy(true); setError(""); setNotice(""); setFileName(file.name);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("O JSON excede o limite de 8 MB.");
      const parsed = JSON.parse(await file.text());
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source)));
      const hash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (!isObject(parsed) || parsed.contract !== CONTRACT || parsed.day !== 3 || parsed.source_hash !== hash || !Array.isArray(parsed.lessons) || parsed.lessons.length < 1 || parsed.lessons.length > 12) throw new Error("Contrato, origem ou quantidade de microaulas inválidos. Gere novamente as instruções para esta mídia.");
      const ids = new Set<string>();
      const normalized = parsed.lessons.map((raw: any, index: number): Lesson => {
        if (!isObject(raw) || !clean(raw.id) || ids.has(raw.id)) throw new Error("ID ausente ou duplicado na microaula " + (index + 1) + ".");
        ids.add(raw.id);
        const score = Number(raw.score);
        const breakdown = raw.score_breakdown;
        if (!Number.isFinite(score) || score < 70 || score > 100 || !isObject(breakdown) || Object.keys(weights).some(key => typeof breakdown[key] !== "number" || breakdown[key] < 0 || breakdown[key] > (weights as any)[key]) || Object.keys(breakdown).length !== Object.keys(weights).length) throw new Error("Pontuação ou score_breakdown inválido na microaula " + raw.id + ".");
        const sum = Object.entries(weights).reduce((total, [key]) => total + breakdown[key], 0);
        if (sum !== score) throw new Error("A soma do score_breakdown deve ser igual ao score em " + raw.id + ".");
        if (!["beginner", "elementary", "intermediate", "upper-intermediate"].includes(raw.difficulty)) throw new Error("difficulty inválido em " + raw.id + ".");
        const cueOrders = Array.isArray(raw.sourceCueOrders) ? raw.sourceCueOrders : [];
        if (!cueOrders.length || cueOrders.some((order: number) => !Number.isInteger(order) || order < 1 || order > cues.length)) throw new Error("sourceCueOrders inválido em " + raw.id + ".");
        const sourceCue = cues[cueOrders[0] - 1];
        if (!sourceCue || !clean(raw.sourceText) || !sourceCue.text.toLowerCase().includes(clean(raw.sourceText).toLowerCase()) || !clean(raw.targetEn) || !raw.sourceText.toLowerCase().includes(raw.targetEn.toLowerCase())) throw new Error("A fala de origem não corresponde à transcrição em " + raw.id + ".");
        if (!clean(raw.title) || !clean(raw.targetPt) || !clean(raw.explanationPt) || !clean(raw.communicativeIntentPt) || !Array.isArray(raw.examples) || raw.examples.length < 2 || !Array.isArray(raw.contextTree) || raw.contextTree.length < 2 || !isObject(raw.practice) || !Array.isArray(raw.practice.options) || raw.practice.options.length < 2 || !raw.practice.options.some((option: any) => option.id === raw.practice.answerId)) throw new Error("A microaula " + raw.id + " está incompleta.");
        return { ...raw, status: "draft", include_in_hub: true } as Lesson;
      });
      normalized.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      onLessonsChange(normalized);
      setNotice(normalized.length + " microaulas importadas e ordenadas por pontuação. Todas aguardam sua revisão.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  function update(id: string, patch: Partial<Lesson>) {
    onLessonsChange(lessons.map(item => item.id === id ? { ...item, ...patch, status: "draft" } : item));
  }
  const approved = lessons.filter(item => (item as Lesson).status === "approved" && (item as Lesson).include_in_hub !== false);
  return <section className="day3-workspace">
    <header className="day3-header"><div><span>JORNADA DE APRENDIZAGEM · DIA 03</span><h3>Notice in Context</h3><p>Perceber significado, intenção comunicativa e reutilização das expressões.</p></div><button type="button" className="day3-back" onClick={onBack}>← Voltar aos dias</button></header>
    <div className="day3-source-summary">
      <div><strong>{approvedCards.length}</strong><span>cards aprovados como fonte</span></div>
      <div><strong>{selectedMoment ? "Sim" : "Não"}</strong><span>Smart Learning Moment selecionado</span></div>
      <div><strong>{lessons.length}</strong><span>microaulas importadas</span></div>
      <div><strong>{approved.length}</strong><span>aprovadas para o iHub</span></div>
    </div>
    {!approvedCards.length && !selectedMoment && <p className="day3-warning">{cues.length ? "Sem cards aprovados ou Smart Learning Moment selecionado, a IA poderá trabalhar diretamente com a transcrição e as cues disponíveis. Ela deverá selecionar apenas oportunidades realmente presentes na cena, sem inventar falas ou contextos." : "Não há cues de transcrição disponíveis para preparar o Dia 3. Verifique se a transcrição foi carregada."}</p>}
    <div className="day3-actions">
      <button type="button" onClick={() => void exportInstructions()} disabled={busy || cues.length === 0}><FileText size={15}/> Exportar instruções para IA</button>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={15}/> Importar JSON</button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => void importJson(event.target.files?.[0])}/>
      <button type="button" onClick={onSave} disabled={saving}><Check size={15}/>{saving ? "Salvando..." : "Salvar"}</button>
      {busy && <span><LoaderCircle className="day3-spin" size={15}/> Processando...</span>}
    </div>
    {fileName && <small className="day3-file">{fileName}</small>}
    {error && <pre className="day3-error">{error}</pre>}
    {notice && <p className="day3-notice">{notice}</p>}
    <div className="day3-lessons">
      {lessons.length === 0 ? <div className="day3-empty"><strong>As microaulas aparecerão aqui</strong><p>Exporte as instruções, gere o JSON com a IA e importe para revisar cada proposta.</p></div> :
        lessons.map((item, index) => {
          const lesson = item as Lesson;
          return <article className="day3-lesson" key={item.id}>
            <div className="day3-lesson-top"><span>#{index + 1} · {lesson.focus}</span><strong>{lesson.score ?? "—"}/100</strong></div>
            <label>Título<input value={item.title} onChange={e => update(item.id, { title: e.target.value })}/></label>
            <div className="day3-source-excerpt"><strong>Trecho original da cena</strong><p>{lesson.sourceText || "Trecho não informado"}</p></div>
            <label>Expressão em inglês<input value={item.targetEn} onChange={e => update(item.id, { targetEn: e.target.value })}/></label>
            <label>Significado contextual<input value={item.targetPt} onChange={e => update(item.id, { targetPt: e.target.value })}/></label>
            <label>Intenção comunicativa<textarea value={lesson.communicativeIntentPt ?? ""} onChange={e => update(item.id, { communicativeIntentPt: e.target.value })}/></label>
            <label>Explicação<textarea value={item.explanationPt} onChange={e => update(item.id, { explanationPt: e.target.value })}/></label>
            <div className="day3-examples"><strong>Exemplos em outros contextos</strong>{item.examples.map((example, i) => <div key={i}>
              <label>EN<input value={example.en} onChange={e => update(item.id, { examples: item.examples.map((entry, index) => index === i ? { ...entry, en: e.target.value } : entry) })}/></label>
              <label>PT<input value={example.pt} onChange={e => update(item.id, { examples: item.examples.map((entry, index) => index === i ? { ...entry, pt: e.target.value } : entry) })}/></label>
            </div>)}</div>
            <div className="day3-contexts"><strong>Árvore de contextos</strong>{(lesson.contextTree ?? []).map((branch, i) => <div key={branch.id}>
              <label>Contexto<input value={branch.title} onChange={e => update(item.id, { contextTree: (lesson.contextTree ?? []).map((entry, index) => index === i ? { ...entry, title: e.target.value } : entry) })}/></label>
              <label>Quando usar<textarea value={branch.purpose} onChange={e => update(item.id, { contextTree: (lesson.contextTree ?? []).map((entry, index) => index === i ? { ...entry, purpose: e.target.value } : entry) })}/></label>
              {(branch.examples ?? []).map((example, j) => <div className="day3-context-example" key={j}>
                <label>EN<input value={example.en} onChange={e => update(item.id, { contextTree: (lesson.contextTree ?? []).map((entry, index) => index === i ? { ...entry, examples: entry.examples.map((sample, sampleIndex) => sampleIndex === j ? { ...sample, en: e.target.value } : sample) } : entry) })}/></label>
                <label>PT<input value={example.pt} onChange={e => update(item.id, { contextTree: (lesson.contextTree ?? []).map((entry, index) => index === i ? { ...entry, examples: entry.examples.map((sample, sampleIndex) => sampleIndex === j ? { ...sample, pt: e.target.value } : sample) } : entry) })}/></label>
              </div>)}
            </div>)}</div>
            <div className="day3-review"><label><input type="checkbox" checked={lesson.include_in_hub !== false} onChange={e => update(item.id, { include_in_hub: e.target.checked })}/> Incluir no iHub</label>
              <button type="button" className={lesson.status === "approved" ? "is-approved" : ""} onClick={() => update(item.id, { status: lesson.status === "approved" ? "draft" : "approved" })}>{lesson.status === "approved" ? "Aprovada ✓" : "Aprovar microaula"}</button>
              <button type="button" onClick={() => update(item.id, { status: "rejected", include_in_hub: false })}>Rejeitar</button>
            </div>
            {lesson.pedagogical_rationale && <small className="day3-rationale">{lesson.pedagogical_rationale}</small>}
          </article>;
        })}
    </div>
    <footer className="day3-footer"><span>{approved.length} de {lessons.length} microaulas aprovadas e incluídas</span><button type="button" className="day3-back" onClick={onBack}>Voltar aos dias</button><button type="button" className="day3-save" onClick={onSave} disabled={saving}>{saving ? "Salvando..." : "Salvar preparação"}</button></footer>
  </section>;
}
