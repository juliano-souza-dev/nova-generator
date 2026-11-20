import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { Check, CheckCircle2, Download, FileText, LoaderCircle, Upload } from "lucide-react";
import type { LearningJourneyPackage, ListeningQuestion } from "./learning-journey-contract";

type Cue = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string;
  words?: { text: string; startMs: number; endMs: number }[];
};
type Candidate = ListeningQuestion & {
  score?: number;
  score_breakdown?: Record<string, number>;
  pedagogical_rationale?: string;
  difficulty?: "beginner" | "elementary" | "intermediate" | "upper-intermediate";
  status?: "draft" | "approved" | "rejected";
  include_in_hub?: boolean;
};
type OutputPackage = {
  contract: "nova-generator-listening-recall-output/1.0";
  source_hash: string;
  day: 2;
  activities: Candidate[];
};
type Props = {
  projectId: string;
  assetId: string;
  sourceSignature: string;
  cues: Cue[];
  activities: ListeningQuestion[];
  onActivitiesChange: (activities: ListeningQuestion[]) => void;
};
const OUTPUT_CONTRACT = "nova-generator-listening-recall-output/1.0" as const;
const INPUT_CONTRACT = "nova-generator-listening-recall-input/1.0" as const;
const TYPES = ["identify", "word-recognition", "gap", "reconstruct"] as const;
const TYPE_LABELS: Record<string, string> = {
  identify: "Identificação de palavras e expressões",
  "word-recognition": "Reconhecimento auditivo",
  gap: "Completar lacunas pelo áudio",
  reconstruct: "Reconstrução de trechos da fala"
};
const normalize = (value: unknown) => typeof value === "string" ? value.trim() : "";
const unique = (values: string[]) => new Set(values).size === values.length;

export default function Day2ListeningRecall({ projectId, assetId, sourceSignature, cues, activities, onActivitiesChange }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | "approve" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fileName, setFileName] = useState("");

  const orderedCues = useMemo(() => cues
    .filter(cue => cue.text.trim() && cue.endMs > cue.startMs)
    .map((cue, index) => ({
      cue_order: index + 1,
      cue_id: cue.id,
      start_ms: Math.round(cue.startMs),
      end_ms: Math.round(cue.endMs),
      speaker: cue.speaker ?? "",
      text_en: cue.text,
      words: (cue.words ?? []).map(word => ({
        text: word.text,
        start_ms: Math.round(word.startMs),
        end_ms: Math.round(word.endMs)
      }))
    })), [cues]);

  const inputPayload = useMemo(() => ({
    contract: INPUT_CONTRACT,
    project_id: projectId,
    asset_id: assetId,
    source_signature: sourceSignature,
    language: { source: "en", support: "pt-BR" },
    day: 2,
    title: "Listening Recall",
    source_cues: orderedCues
  }), [projectId, assetId, sourceSignature, orderedCues]);

  async function sourceHash() {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(inputPayload)));
    return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("");
  }

  async function exportInstructions() {
    if (!assetId || orderedCues.length < 4 || busy) return;
    setBusy("export"); setError(""); setNotice("");
    try {
      const hash = await sourceHash();
      const lines = [
        "NOVA GENERATOR | JORNADA DE APRENDIZAGEM",
        "DAY 02 · LISTENING RECALL",
        "EXTERNAL AI GENERATION PACKAGE | INPUT 1.0",
        "INPUT_CONTRACT: " + INPUT_CONTRACT,
        "REQUIRED_OUTPUT_CONTRACT: " + OUTPUT_CONTRACT,
        "SOURCE_HASH: " + hash,
        "PROJECT_ID: " + projectId,
        "ASSET_ID: " + assetId,
        "SOURCE_SIGNATURE: " + sourceSignature,
        "LANGUAGE: English",
        "SUPPORT_LANGUAGE: Brazilian Portuguese",
        "",
        "============================================================",
        "1. PEDAGOGICAL MISSION",
        "============================================================",
        "Create a focused Listening Recall sequence for Day 2. The learner has already explored and understood the scene on Day 1. Day 2 must train accurate auditory retrieval from the original audio, not test general reading comprehension and not simply ask the learner to replay the video.",
        "Generate a compact, high-quality set of activities across all four modalities: (A) identify words and expressions heard; (B) recognize a target word or expression by listening; (C) complete a meaningful gap from the audio; (D) reconstruct a short spoken excerpt in the correct word order.",
        "Use only supplied cue IDs, cue orders and timestamps. The iHub player will play the original audio at those cue orders. The TXT does not contain the audio itself; never claim to have heard, analyzed or measured the recording.",
        "",
        "2. DESIGN PRINCIPLES",
        "Prioritize auditory memory, sound-to-meaning association, lexical retrieval, phrase recognition and sequence reconstruction. Every task must require listening to the linked original audio before answering.",
        "Choose moments with clear, useful language and enough audio context. Prefer short utterances or meaningful excerpts. Do not select a cue merely because it is easy to turn into a question.",
        "Keep instructions direct and beginner-friendly. Use English for learner-facing prompts only when it is simpler than Portuguese; otherwise use concise Brazilian Portuguese. Explanations and feedback must be in natural Brazilian Portuguese.",
        "Do not create trivia, translation-only questions, grammar explanations, prediction tasks, or tasks solvable by reading the prompt without listening.",
        "Avoid duplicate targets and repeated use of the same cue unless the second task trains a genuinely different listening skill. Vary speakers and moments when the source allows it.",
        "Do not invent words, alternative answers, speaker details, acoustic properties, pronunciation facts or timestamps. Use the transcript as the source of truth for lexical content and timing.",
        "",
        "3. FOUR REQUIRED ACTIVITY TYPES",
        "identify: Show 3 or 4 short candidate words/expressions/sentences. Ask which one the learner heard in the linked audio. Exactly one answerId. Distractors must be plausible but clearly absent from that exact audio excerpt. Keep options similar in length and category.",
        "word-recognition: Focus on one important word or compact expression. Ask the learner to recognize which item was actually spoken. Use 3 or 4 plausible alternatives. Do not fabricate minimal pairs or claim sound contrasts that cannot be verified from the transcript.",
        "gap: Present the original sentence with exactly one meaningful lexical gap represented by _____. The learner listens and types the missing word or short expression. acceptedAnswers must contain only legitimate variants that preserve the spoken wording (for example, punctuation/case variants are not needed).",
        "reconstruct: Select a short, coherent spoken excerpt, ideally 4–9 words. Provide words as a shuffled word bank and answer as the exact original word sequence. Preserve contractions and lexical identity. Do not add or remove words. Use the same tokens in words and answer, including repeated tokens.",
        "",
        "4. QUANTITY AND QUALITY",
        "Aim for 8–12 activities total, usually 2–3 per type. Quality takes priority over quantity. Return fewer only if the source does not support more high-quality tasks, but include at least one valid activity of each of the four types when possible.",
        "Score each candidate from 0 to 100 using: auditory-learning value 20; fidelity to source wording and cue 20; clarity of task and answer 15; pedagogical usefulness 15; level appropriateness 10; distractor/response quality 10; variety and non-redundancy 10.",
        "Return candidates in descending score order. Reject any candidate below 70 instead of padding the list. A score is not a substitute for validation.",
        "",
        "5. REQUIRED OUTPUT FIELDS",
        "Each activity: id, type, prompt, audioCueOrders, explanationPt, feedbackCorrectPt, feedbackIncorrectPt, difficulty, score, score_breakdown, pedagogical_rationale.",
        "For identify and word-recognition: options [{id,text}] and answerId.",
        "For gap: sentence, acceptedAnswers, optional hint.",
        "For reconstruct: words (shuffled bank) and answer (correct order).",
        "Use stable unique IDs such as day2-identify-01. audioCueOrders must contain one or more existing cue_order values from the source. Keep each task anchored to the smallest useful original excerpt.",
        "",
        "6. STRICT OUTPUT RULES",
        "Return ONLY valid JSON. No Markdown, no comments and no prose outside JSON. Do not include Day 1 or any other day.",
        "Do not alter SOURCE_HASH. Do not invent cue orders. Do not use empty placeholders. Exactly one correct option is allowed for choice activities.",
        "",
        "7. OUTPUT TEMPLATE",
        JSON.stringify({
          contract: OUTPUT_CONTRACT,
          source_hash: hash,
          day: 2,
          activities: [{
            id: "day2-identify-01",
            type: "identify",
            prompt: "Qual expressão você ouviu?",
            audioCueOrders: [1],
            options: [{ id: "a", text: "..." }, { id: "b", text: "..." }, { id: "c", text: "..." }],
            answerId: "a",
            explanationPt: "...",
            feedbackCorrectPt: "...",
            feedbackIncorrectPt: "...",
            difficulty: "beginner",
            score: 90,
            score_breakdown: {
              auditory_learning_value: 18, source_fidelity: 20, clarity: 14,
              pedagogical_usefulness: 14, level_fit: 9, response_quality: 9, variety: 6
            },
            pedagogical_rationale: "..."
          }],
          // Gap example: { id, type: "gap", prompt, audioCueOrders: [2], sentence: "I _____ it out.", acceptedAnswers: ["figured"], hint, explanationPt, feedbackCorrectPt, feedbackIncorrectPt, difficulty, score, score_breakdown, pedagogical_rationale }
          // Reconstruction example: { id, type: "reconstruct", prompt, audioCueOrders: [3], words: ["today", "go", "we", "should"], answer: ["we", "should", "go", "today"], explanationPt, feedbackCorrectPt, feedbackIncorrectPt, difficulty, score, score_breakdown, pedagogical_rationale }
        }, null, 2),
        "",
        "8. SOURCE CUES",
        JSON.stringify(inputPayload, null, 2)
      ];
      const path = await saveFile({
        title: "Salvar instruções do Day 2 para IA externa",
        defaultPath: "day-2-listening-recall-instrucoes.txt",
        filters: [{ name: "Instruções para IA externa", extensions: ["txt"] }]
      });
      if (!path) return;
      await invoke("save_external_translation_package", { path, bytes: Array.from(new TextEncoder().encode(lines.join("\n"))) });
      setNotice("Instruções do Day 2 exportadas. Envie o TXT à IA e importe o JSON de retorno.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); }
  }

  function validateCandidate(raw: any, index: number, cueOrders: Set<number>): string[] {
    const errors: string[] = [];
    if (!normalize(raw?.id)) errors.push("ID ausente");
    if (!TYPES.includes(raw?.type)) errors.push("tipo inválido");
    if (!normalize(raw?.prompt)) errors.push("instrução ausente");
    if (!Array.isArray(raw?.audioCueOrders) || !raw.audioCueOrders.length || raw.audioCueOrders.some((order: any) => !cueOrders.has(Number(order)))) errors.push("referência de áudio inválida");
    if (!normalize(raw?.explanationPt)) errors.push("explicação pedagógica ausente");
    const score = Number(raw?.score);
    if (!Number.isFinite(score) || score < 70 || score > 100) errors.push("pontuação abaixo de 70 ou inválida");
    if (raw?.type === "identify" || raw?.type === "word-recognition") {
      if (!Array.isArray(raw.options) || raw.options.length < 3 || raw.options.length > 4) errors.push("precisa de 3 ou 4 alternativas");
      else {
        const ids = raw.options.map((option: any) => normalize(option?.id));
        const labels = raw.options.map((option: any) => normalize(option?.text).toLocaleLowerCase());
        if (ids.some((id: string) => !id) || !unique(ids) || !unique(labels)) errors.push("alternativas vazias ou repetidas");
        if (!ids.includes(normalize(raw.answerId))) errors.push("resposta correta não existe nas alternativas");
      }
    }
    if (raw?.type === "gap") {
      if (!normalize(raw.sentence).includes("_____")) errors.push("lacuna não identificada");
      if (!Array.isArray(raw.acceptedAnswers) || !raw.acceptedAnswers.length || raw.acceptedAnswers.some((answer: any) => !normalize(answer))) errors.push("resposta aceita ausente");
    }
    if (raw?.type === "reconstruct") {
      if (!Array.isArray(raw.words) || raw.words.length < 3 || raw.words.length > 12 || !Array.isArray(raw.answer) || raw.answer.length !== raw.words.length) errors.push("banco de palavras ou resposta inválidos");
      else if ([...raw.words].sort().join("|") !== [...raw.answer].sort().join("|")) errors.push("banco e resposta não contêm exatamente as mesmas palavras");
    }
    if (index > 100) errors.push("limite de atividades excedido");
    return errors;
  }

  async function importResult(file?: File) {
    if (!file || busy) return;
    setBusy("import"); setError(""); setNotice(""); setFileName(file.name);
    try {
      const parsed = JSON.parse(await file.text()) as OutputPackage;
      if (parsed?.contract !== OUTPUT_CONTRACT || parsed.day !== 2 || !Array.isArray(parsed.activities)) {
        throw new Error("Contrato inválido. Importe o JSON produzido a partir das instruções do Day 2.");
      }
      const expectedHash = await sourceHash();
      if (parsed.source_hash !== expectedHash) throw new Error("O JSON foi gerado para outra mídia ou outra versão da transcrição. Exporte instruções atualizadas.");
      const validOrders = new Set(orderedCues.map(cue => cue.cue_order));
      const ids = parsed.activities.map(item => normalize(item?.id));
      if (!unique(ids) || ids.some(id => !id)) throw new Error("Existem IDs de atividade ausentes ou duplicados.");
      const rejected = parsed.activities.map((item, index) => ({ item, index, errors: validateCandidate(item, index, validOrders) }))
        .filter(entry => entry.errors.length);
      if (rejected.length) throw new Error("JSON não aprovado pela validação:\n" + rejected.slice(0, 8).map(entry => entry.item?.id + ": " + entry.errors.join(", ")).join("\n"));
      const counts = new Map<string, number>();
      parsed.activities.forEach(item => counts.set(item.type, (counts.get(item.type) ?? 0) + 1));
      const missing = TYPES.filter(type => !counts.get(type));
      if (missing.length) throw new Error("A IA precisa entregar pelo menos uma atividade de cada modalidade: " + missing.map(type => TYPE_LABELS[type]).join("; "));
      const normalized = parsed.activities.map(item => ({
        ...item,
        status: "draft" as const,
        include_in_hub: true
      }));
      onActivitiesChange(normalized);
      setNotice(normalized.length + " atividades importadas e validadas. Todas estão em rascunho, aguardando sua aprovação.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function updateCandidate(id: string, patch: Partial<Candidate>) {
    onActivitiesChange(activities.map(item => item.id === id ? { ...item, ...patch } as ListeningQuestion : item));
  }

  function approveSelected() {
    const selected = activities.filter(item => (item as Candidate).include_in_hub !== false && (item as Candidate).status !== "rejected");
    if (!selected.length) {
      setError("Selecione ao menos uma atividade para aprovar.");
      return;
    }
    onActivitiesChange(activities.map(item => selected.some(candidate => candidate.id === item.id)
      ? { ...item, status: "approved", include_in_hub: true } as ListeningQuestion
      : item));
    setNotice(selected.length + " atividades aprovadas para o pacote do iHub.");
  }

  const approvedCount = activities.filter(item => (item as Candidate).status === "approved" && (item as Candidate).include_in_hub !== false).length;
  const selectedCount = activities.filter(item => (item as Candidate).include_in_hub !== false && (item as Candidate).status !== "rejected").length;
  const counts = TYPES.map(type => ({
    type, count: activities.filter(item => item.type === type).length,
    approved: activities.filter(item => item.type === type && (item as Candidate).status === "approved" && (item as Candidate).include_in_hub !== false).length
  }));

  return <section className="day2-listening-recall">
    <header className="day2-listening-recall__header">
      <div><span className="eyebrow">DAY 02 · LISTENING RECALL</span><h3>Treinar o ouvido para recuperar o que foi dito</h3>
        <p>Quatro modalidades de escuta, com atividades criadas pela IA a partir dos trechos reais da transcrição e revisadas antes de chegar ao aluno.</p></div>
      <div className="day2-listening-recall__actions">
        <button className="secondary-button" type="button" onClick={() => void exportInstructions()} disabled={busy !== "" || orderedCues.length < 4}>
          {busy === "export" ? <LoaderCircle className="spin" size={14}/> : <FileText size={14}/>} Exportar instruções para IA
        </button>
        <button className="secondary-button" type="button" onClick={() => fileInput.current?.click()} disabled={busy !== ""}>
          {busy === "import" ? <LoaderCircle className="spin" size={14}/> : <Upload size={14}/>} Importar JSON da IA
        </button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => void importResult(event.target.files?.[0])}/>
        <button className="primary-button" type="button" onClick={approveSelected} disabled={!selectedCount || busy !== ""}>
          <CheckCircle2 size={14}/> Aprovar selecionadas
        </button>
      </div>
    </header>
    <div className="day2-listening-recall__stats">
      {counts.map(item => <div key={item.type}><strong>{item.approved}/{item.count}</strong><span>{TYPE_LABELS[item.type]}</span></div>)}
      <div><strong>{approvedCount}/{activities.length}</strong><span>Aprovadas</span></div>
    </div>
    {error && <p className="day2-listening-recall__message is-error">{error}</p>}
    {notice && <p className="day2-listening-recall__message is-success">{notice}</p>}
    {!activities.length ? <div className="day2-listening-recall__empty"><FileText size={22}/><strong>Nenhum exercício importado</strong><p>Exporte as instruções, envie o TXT à IA e importe o JSON produzido. A IA deverá criar exercícios dos quatro tipos.</p></div> :
      <div className="day2-listening-recall__list">
        {activities.map((item, index) => {
          const candidate = item as Candidate;
          const selected = candidate.include_in_hub !== false && candidate.status !== "rejected";
          return <article key={item.id} className={"day2-listening-recall__item" + (candidate.status === "approved" ? " is-approved" : candidate.status === "rejected" ? " is-rejected" : "")}>
            <div className="day2-listening-recall__item-head">
              <label><input type="checkbox" checked={selected} onChange={event => updateCandidate(item.id, { include_in_hub: event.target.checked, status: event.target.checked && candidate.status === "rejected" ? "draft" : candidate.status })}/><span>ATIVIDADE {String(index + 1).padStart(2, "0")}</span></label>
              <span className="day2-listening-recall__score">Score {candidate.score ?? "—"}</span>
              <span className={"day2-listening-recall__status " + (candidate.status ?? "draft")}>{candidate.status === "approved" ? "Aprovada" : candidate.status === "rejected" ? "Rejeitada" : "Rascunho"}</span>
            </div>
            <strong>{TYPE_LABELS[item.type] ?? item.type}</strong>
            <p>{item.prompt}</p>
            <small>Áudio: {item.audioCueOrders.join(", ")} · {candidate.difficulty ?? "nível não definido"}</small>
            {candidate.pedagogical_rationale && <p className="day2-listening-recall__rationale">{candidate.pedagogical_rationale}</p>}
            {item.type === "gap" && <div className="day2-listening-recall__preview">{item.sentence}</div>}
            {item.type === "reconstruct" && <div className="day2-listening-recall__preview">{item.words.join(" · ")} → {item.answer.join(" ")}</div>}
            {(item.type === "identify" || item.type === "word-recognition") && <ul>{item.options.map(option => <li key={option.id}>{option.text}{option.id === item.answerId ? " ✓" : ""}</li>)}</ul>}
            <p className="day2-listening-recall__explanation">{candidate.explanationPt}</p>
            <div className="day2-listening-recall__item-actions">
              <button type="button" className="secondary-button" onClick={() => updateCandidate(item.id, { status: candidate.status === "rejected" ? "draft" : "rejected", include_in_hub: false })}>{candidate.status === "rejected" ? "Reabrir" : "Rejeitar"}</button>
              <button type="button" className="secondary-button" onClick={() => updateCandidate(item.id, { status: "approved", include_in_hub: true })} disabled={candidate.status === "approved"}><Check size={13}/> Aprovar</button>
            </div>
          </article>;
        })}
      </div>}
    {fileName && <small className="day2-listening-recall__filename">Último arquivo importado: {fileName}</small>}
  </section>;
}
