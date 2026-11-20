import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { Check, FileText, LoaderCircle, Upload } from "lucide-react";
import type { DeepListeningTask } from "./learning-journey-contract";
import "./Day4DeepListening.css";

type Cue = { id: string; text: string; startMs: number; endMs: number; words?: { text: string; startMs: number; endMs: number }[] };
type Candidate = DeepListeningTask & {
  sourceText?: string; targetText?: string; focus?: string; phenomenon?: string;
  options?: { id: string; text: string }[]; answerId?: string; phraseGroups?: string[];
  score?: number; score_breakdown?: Record<string, number>; pedagogical_rationale?: string;
  difficulty?: "beginner" | "elementary" | "intermediate" | "upper-intermediate";
  status?: "draft" | "approved" | "rejected"; include_in_hub?: boolean;
};
type Props = {
  projectId: string; assetId: string; sourceSignature: string; cues: Cue[];
  tasks: DeepListeningTask[]; onTasksChange: (tasks: DeepListeningTask[]) => void;
  onBack: () => void; onSave: () => void; saving: boolean;
};
const INPUT_CONTRACT = "nova-generator-deep-listening-input/1.0";
const OUTPUT_CONTRACT = "nova-generator-deep-listening-output/1.0";
const weights = { auditory_depth: 20, source_fidelity: 20, listening_skill: 15, clarity: 15, pedagogical_value: 10, level_fit: 10, variety: 10 };
const modes = ["no-subtitles", "gap-fill", "connected-speech", "rhythm"] as const;
const labels: Record<string, string> = {
  "no-subtitles": "Escuta sem legendas", "gap-fill": "Compreensão por lacunas",
  "connected-speech": "Connected speech", rhythm: "Ritmo e grupos de sentido"
};
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const isObject = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim().replace(/\s+/g, " ");

export default function Day4DeepListening({ projectId, assetId, sourceSignature, cues, tasks, onTasksChange, onBack, onSave, saving }: Props) {
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
    language: { source: "en", support: "pt-BR" }, day: 4, title: "Deep Listening", source_cues: sourceCues,
    constraints: { audio_is_not_embedded: true, use_transcript_and_word_timestamps_only_for_source_selection: true }
  }), [projectId, assetId, sourceSignature, sourceCues]);

  async function getHash() {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
    return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, "0")).join("");
  }

  async function exportInstructions() {
    if (busy || sourceCues.length < 4) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const hash = await getHash();
      const template = {
        contract: OUTPUT_CONTRACT, source_hash: hash, day: 4,
        tasks: [{
          id: "deep-01", cueOrders: [1], mode: "no-subtitles",
          prompt: "Listen to the original cue without subtitles and choose the main idea.",
          sourceText: "exact excerpt copied from the selected cue",
          targetText: "exact words or phrase being examined",
          options: [{ id: "a", text: "plausible answer" }, { id: "b", text: "correct answer" }, { id: "c", text: "plausible answer" }],
          answerId: "b", expectedText: "the correct answer",
          sentence: "optional sentence with exactly one _____",
          acceptedAnswers: ["optional exact missing word"],
          focus: "what the learner should listen for",
          phenomenon: "consonant-vowel-linking",
          phraseGroups: ["first thought group", "second thought group"],
          explanationPt: "short explanation in Brazilian Portuguese",
          feedbackCorrectPt: "brief correct feedback", feedbackIncorrectPt: "listen again feedback",
          score: 90, score_breakdown: { auditory_depth: 18, source_fidelity: 19, listening_skill: 14, clarity: 14, pedagogical_value: 9, level_fit: 8, variety: 8 },
          pedagogical_rationale: "specific reason this cue trains deep listening", difficulty: "beginner"
        }]
      };
      const lines = [
        "NOVA GENERATOR | JORNADA DE APRENDIZAGEM", "DAY 04 · DEEP LISTENING",
        "EXTERNAL AI GENERATION PACKAGE | INPUT 1.0",
        "INPUT_CONTRACT: " + INPUT_CONTRACT, "REQUIRED_OUTPUT_CONTRACT: " + OUTPUT_CONTRACT,
        "SOURCE_HASH: " + hash, "PROJECT_ID: " + projectId, "ASSET_ID: " + assetId,
        "SOURCE_SIGNATURE: " + sourceSignature, "",
        "1. MISSÃO PEDAGÓGICA",
        "Crie atividades de Deep Listening. O aluno já explorou a cena, recuperou palavras e expressões e estudou significados em contexto. Agora deve compreender a fala natural com menos apoio visual, perceber como palavras se conectam e acompanhar o ritmo dos grupos de sentido.",
        "2. QUATRO MODALIDADES OBRIGATÓRIAS",
        "no-subtitles: o aluno ouve o trecho original sem legendas e responde uma pergunta de compreensão global ou de detalhe. Use 3 ou 4 alternativas, uma única correta. A pergunta não pode ser resolvida apenas lendo as alternativas.",
        "gap-fill: apresente a fala original com exatamente uma lacuna significativa (_____). A resposta deve ser recuperável ouvindo o áudio. A frase completa deve corresponder literalmente ao trecho.",
        "connected-speech: selecione uma sequência exata de palavras consecutivas e útil para perceber ligação entre palavras, contrações ou reduções comuns. Informe phenomenon com uma destas opções: consonant-vowel-linking, consonant-linking, contraction, common-reduction, resyllabification. Não invente grafias fonéticas nem afirme detalhes acústicos que não podem ser comprovados pelo texto. O áudio original é que será ouvido pelo aluno.",
        "rhythm: use os tempos das palavras para identificar pausas ou grupos de sentido. phraseGroups deve dividir a fala em grupos consecutivos, mantendo todas as palavras originais, na ordem exata e sem omissões ou acréscimos. Não invente sílabas tônicas ou entonação que não estejam disponíveis nos dados.",
        "3. FIDELIDADE À FONTE",
        "O TXT contém transcrição e tempos, não contém áudio. Não afirme que você ouviu, mediu velocidade, volume, sotaque ou pronúncia da gravação. Use apenas cueOrders existentes. sourceText deve ser um excerto exato da cue referenciada; targetText deve estar contido nele. Não invente falas, palavras ou timestamps. Para rhythm, respeite a ordem e a integridade das palavras. Para connected-speech, descreva apenas fenômenos plausíveis pela sequência escrita e não apresente uma pronúncia inventada como fato.",
        "4. QUANTIDADE E QUALIDADE",
        "Produza preferencialmente 8 atividades, em geral 2 por modalidade. Aceite entre 4 e 12. Inclua pelo menos uma atividade de cada modalidade. Se uma cue não sustentar uma atividade, escolha outra cue. Nunca invente conteúdo para preencher uma modalidade. Se a mídia inteira não oferecer base suficiente para as quatro modalidades, retorne tasks vazio; nesse caso, a importação será recusada e a fonte deverá ser revista. Qualidade acima da quantidade.",
        "Toda tarefa deve exigir ouvir o áudio original. Prompts e feedbacks curtos; explicações em português brasileiro; nível beginner como padrão, elevando somente quando a linguagem exigir.",
        "5. PONTUAÇÃO",
        "score deve ser número JSON entre 70 e 100. score_breakdown deve conter exatamente estas chaves, sem extras, com valores numéricos e soma igual a score: " + JSON.stringify(weights) + ".",
        "difficulty deve ser exatamente beginner, elementary, intermediate ou upper-intermediate. Retorne tarefas em ordem decrescente de score. IDs únicos. cueOrders deve conter exatamente um número de cue_order existente.",
        "6. CAMPOS E REGRAS POR MODALIDADE",
        "Campos obrigatórios em toda tarefa: id, cueOrders, mode, prompt, sourceText, targetText, explanationPt, feedbackCorrectPt, feedbackIncorrectPt, score, score_breakdown, pedagogical_rationale, difficulty.",
        "no-subtitles: options com 3 ou 4 objetos {id,text}, answerId válido e expectedText com a resposta correta.",
        "gap-fill: sentence com exatamente uma ocorrência de _____; acceptedAnswers com a resposta exata; ao substituir a lacuna por uma resposta aceita, o texto deve corresponder ao sourceText.",
        "connected-speech: focus com a sequência exata a observar; phenomenon com um dos valores permitidos.",
        "rhythm: phraseGroups como array de 2 ou mais grupos. Juntando os grupos, todas as palavras devem preservar a sequência original de sourceText.",
        "7. SAÍDA",
        "Retorne SOMENTE JSON válido, sem Markdown, comentários ou texto externo. Não inclua outros dias.",
        JSON.stringify(template, null, 2), "", "8. MATERIAL DE ORIGEM", JSON.stringify(input, null, 2)
      ];
      const path = await saveFile({ title: "Salvar instruções do Dia 4", defaultPath: "day-4-deep-listening-" + assetId + ".txt", filters: [{ name: "Instruções para IA externa", extensions: ["txt"] }] });
      if (!path) return;
      await invoke("save_external_translation_package", { path, bytes: Array.from(new TextEncoder().encode("\uFEFF" + lines.join("\r\n"))) });
      setNotice("Instruções do Dia 4 exportadas.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function validateTask(raw: any, validOrders: Set<number>, index: number): string[] {
    const errors: string[] = [];
    if (!clean(raw?.id)) errors.push("ID ausente");
    if (!modes.includes(raw?.mode)) errors.push("modalidade inválida");
    if (!clean(raw?.prompt) || !clean(raw?.sourceText) || !clean(raw?.targetText)) errors.push("prompt, sourceText ou targetText ausente");
    if (!Array.isArray(raw?.cueOrders) || raw.cueOrders.length !== 1 || !validOrders.has(Number(raw.cueOrders[0]))) errors.push("cueOrders deve apontar para exatamente uma cue válida");
    if (!clean(raw?.explanationPt) || !clean(raw?.feedbackCorrectPt) || !clean(raw?.feedbackIncorrectPt) || !clean(raw?.pedagogical_rationale)) errors.push("explicação, feedback ou justificativa ausente");
    if (!["beginner", "elementary", "intermediate", "upper-intermediate"].includes(raw?.difficulty)) errors.push("difficulty inválido");
    const score = raw?.score;
    const breakdown = raw?.score_breakdown;
    const keys = Object.keys(weights);
    if (typeof score !== "number" || score < 70 || score > 100 || !isObject(breakdown) ||
      Object.keys(breakdown).length !== keys.length ||
      keys.some(key => typeof breakdown[key] !== "number" || breakdown[key] < 0 || breakdown[key] > (weights as any)[key]) ||
      keys.reduce((sum, key) => sum + (breakdown[key] ?? 0), 0) !== score) errors.push("score_breakdown inválido: use exatamente as sete chaves e respeite os pesos");
    const cue = Array.isArray(raw?.cueOrders) ? sourceCues.find(item => item.cue_order === Number(raw.cueOrders[0])) : undefined;
    const source = normalize(clean(raw?.sourceText));
    const target = normalize(clean(raw?.targetText));
    if (!cue || !normalize(cue.text_en).includes(source) || !source.includes(target)) errors.push("sourceText ou targetText não corresponde exatamente à cue");
    if (raw?.mode === "no-subtitles") {
      const correctOption = Array.isArray(raw.options) ? raw.options.find((option: any) => option.id === raw.answerId) : undefined;
      if (!Array.isArray(raw.options) || raw.options.length < 3 || raw.options.length > 4 ||
        !correctOption || new Set(raw.options.map((option: any) => normalize(clean(option.text)))).size !== raw.options.length ||
        !clean(raw.expectedText) || normalize(clean(raw.expectedText)) !== normalize(clean(correctOption?.text))) {
        errors.push("no-subtitles precisa de 3 ou 4 alternativas únicas, answerId válido e expectedText igual à alternativa correta");
      }
    }
    if (raw?.mode === "gap-fill") {
      if ((clean(raw.sentence).match(/_____/g) ?? []).length !== 1 || !Array.isArray(raw.acceptedAnswers) || !raw.acceptedAnswers.length ||
        !raw.acceptedAnswers.some((answer: string) => normalize(clean(raw.sentence).replace("_____", clean(answer))) === source)) errors.push("gap-fill precisa de uma lacuna e resposta que restaure o trecho original");
    }
    if (raw?.mode === "connected-speech") {
      const phenomena = ["consonant-vowel-linking", "consonant-linking", "contraction", "common-reduction", "resyllabification"];
      if (!clean(raw.focus) || !source.includes(normalize(clean(raw.focus))) || !phenomena.includes(raw.phenomenon)) errors.push("connected-speech precisa de foco exato e phenomenon permitido");
    }
    if (raw?.mode === "rhythm") {
      if (!Array.isArray(raw.phraseGroups) || raw.phraseGroups.length < 2 ||
        normalize(raw.phraseGroups.join(" ")) !== source) errors.push("rhythm precisa dividir sourceText em grupos mantendo todas as palavras na ordem original");
    }
    if (index >= 12) errors.push("limite de 12 tarefas excedido");
    return errors;
  }

  async function importJson(file?: File) {
    if (!file || busy) return;
    setBusy(true); setError(""); setNotice(""); setFileName(file.name);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("O JSON excede 8 MB.");
      const parsed = JSON.parse(await file.text());
      if (!isObject(parsed) || parsed.contract !== OUTPUT_CONTRACT || parsed.day !== 4 || !Array.isArray(parsed.tasks) || parsed.tasks.length < 4 || parsed.tasks.length > 12) throw new Error("Contrato, dia ou quantidade de tarefas inválidos.");
      if (parsed.source_hash !== await getHash()) throw new Error("O JSON foi gerado para outra mídia ou versão da transcrição. Exporte as instruções novamente.");
      for (let i = 1; i < parsed.tasks.length; i++) if (Number(parsed.tasks[i - 1]?.score) < Number(parsed.tasks[i]?.score)) throw new Error("As tarefas precisam estar ordenadas da maior para a menor pontuação.");
      const ids = parsed.tasks.map((task: any) => clean(task?.id));
      if (ids.some((id: string) => !id) || new Set(ids).size !== ids.length) throw new Error("Existem IDs ausentes ou duplicados.");
      const validOrders = new Set(sourceCues.map(cue => cue.cue_order));
      const invalid = parsed.tasks.map((task: any, index: number) => ({ task, errors: validateTask(task, validOrders, index) })).filter((entry: any) => entry.errors.length);
      if (invalid.length) throw new Error("JSON não aprovado pela validação:\n" + invalid.slice(0, 8).map((entry: any) => entry.task?.id + ": " + entry.errors.join(", ")).join("\n"));
      const missing = modes.filter(mode => !parsed.tasks.some((task: any) => task.mode === mode));
      if (missing.length) throw new Error("Inclua pelo menos uma tarefa de cada modalidade: " + missing.map(mode => labels[mode]).join("; "));
      const imported = parsed.tasks.map((task: Candidate) => ({ ...task, status: "approved" as const }));
      onTasksChange(imported);
      setNotice(imported.length + " tarefas importadas e aprovadas. Você pode rejeitar as que não deseja enviar ao iHub.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  function update(id: string, patch: Partial<Candidate>) {
    onTasksChange(tasks.map(task => task.id === id ? { ...task, ...patch } as DeepListeningTask : task));
  }
  const approved = tasks.filter(task => (task as Candidate).status === "approved" && (task as Candidate).include_in_hub !== false);
  return <section className="day4-workspace">
    <header className="day4-header"><div><span>JORNADA DE APRENDIZAGEM · DIA 04</span><h3>Deep Listening</h3><p>Compreender a fala natural sem depender das legendas.</p></div><button type="button" onClick={onBack}>← Voltar aos dias</button></header>
    <div className="day4-summary">
      <div><strong>{sourceCues.length}</strong><span>trechos disponíveis</span></div>
      <div><strong>{tasks.length}</strong><span>tarefas importadas</span></div>
      <div><strong>{approved.length}</strong><span>aprovadas para o iHub</span></div>
      <div><strong>{modes.filter(mode => approved.some(task => task.mode === mode)).length}/4</strong><span>modalidades aprovadas</span></div>
    </div>
    <div className="day4-actions">
      <button type="button" onClick={() => void exportInstructions()} disabled={busy || sourceCues.length < 4}><FileText size={15}/> Exportar instruções para IA</button>
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={15}/> Importar JSON</button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => void importJson(event.target.files?.[0])}/>
      <button type="button" onClick={onSave} disabled={saving || busy}><Check size={15}/>{saving ? "Salvando..." : "Salvar"}</button>
      {busy && <span><LoaderCircle className="day4-spin" size={15}/> Processando...</span>}
    </div>
    {fileName && <small className="day4-file">{fileName}</small>}
    {error && <pre className="day4-error">{error}</pre>}
    {notice && <p className="day4-notice">{notice}</p>}
    <div className="day4-list">
      {!tasks.length ? <div className="day4-empty"><strong>As atividades aparecerão aqui</strong><p>Exporte as instruções, gere o JSON com a IA e importe para revisar.</p></div> :
        tasks.map((task, index) => {
          const item = task as Candidate;
          return <article className={"day4-task" + (item.status === "approved" ? " is-approved" : item.status === "rejected" ? " is-rejected" : "")} key={task.id}>
            <div className="day4-task-top"><span>#{index + 1} · {labels[task.mode] ?? task.mode}</span><strong>{item.score ?? "—"}/100</strong></div>
            <p className="day4-prompt">{task.prompt}</p>
            <div className="day4-source"><strong>Trecho original</strong><p>{item.sourceText || "Trecho não informado"}</p></div>
            <label>Foco da escuta<input value={item.focus ?? item.targetText ?? ""} onChange={event => update(task.id, { focus: event.target.value })}/></label>
            <label>Instrução<textarea value={task.prompt} onChange={event => update(task.id, { prompt: event.target.value })}/></label>
            {task.mode === "no-subtitles" && <div className="day4-detail"><strong>Alternativas</strong>{(item.options ?? []).map(option => <p key={option.id}>{option.text}{option.id === item.answerId ? " ✓" : ""}</p>)}</div>}
            {task.mode === "gap-fill" && <div className="day4-detail"><strong>Frase com lacuna</strong><p>{task.sentence}</p><small>Resposta: {(task.acceptedAnswers ?? []).join(" / ")}</small></div>}
            {task.mode === "connected-speech" && <div className="day4-detail"><strong>Fenômeno</strong><p>{item.phenomenon} · {item.focus}</p></div>}
            {task.mode === "rhythm" && <div className="day4-detail"><strong>Grupos de sentido</strong><p>{(item.phraseGroups ?? []).join(" / ")}</p></div>}
            <label>Explicação<textarea value={task.explanationPt ?? ""} onChange={event => update(task.id, { explanationPt: event.target.value })}/></label>
            <div className="day4-review">
              <button type="button" onClick={() => update(task.id, { status: "approved", include_in_hub: true })} disabled={item.status === "approved"}>Aprovar</button>
              <button type="button" onClick={() => update(task.id, { status: "rejected", include_in_hub: false })} disabled={item.status === "rejected"}>Rejeitar</button>
            </div>
            {item.pedagogical_rationale && <small className="day4-rationale">{item.pedagogical_rationale}</small>}
          </article>;
        })}
    </div>
    <footer className="day4-footer"><span>{approved.length} de {tasks.length} tarefas aprovadas e incluídas</span><button type="button" onClick={onBack}>Voltar aos dias</button><button type="button" onClick={onSave} disabled={saving}>Salvar preparação</button></footer>
  </section>;
}
