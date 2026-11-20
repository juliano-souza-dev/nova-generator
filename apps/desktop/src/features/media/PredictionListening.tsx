import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, FileJson, FileText, PlayCircle, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import "./PredictionListening.css";

type Cue = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  wordAlignment?: string | null;
  words?: { text: string; startMs: number; endMs: number }[];
};
type Package = {
  packageVersion: string;
  contractId: string;
  sourceHash: string;
  files: Record<string, string>;
};
type Choice = { text: string; is_correct: boolean };
type PredictionScoreKey = "contextual_fit" | "prediction_value" | "communicative_value" | "answerability" | "pause_quality" | "level_fit" | "distractor_quality" | "variety";
type PredictionScoreBreakdown = Record<PredictionScoreKey, number>;
type PredictionScoreEvidence = Record<PredictionScoreKey, string>;
const PREDICTION_SCORE_WEIGHTS: PredictionScoreBreakdown = {
  contextual_fit: 20, prediction_value: 20, communicative_value: 15, answerability: 15,
  pause_quality: 10, level_fit: 10, distractor_quality: 5, variety: 5
};
const PREDICTION_SCORE_LABELS: Record<PredictionScoreKey, string> = {
  contextual_fit: "Adequação ao contexto", prediction_value: "Valor da previsão",
  communicative_value: "Utilidade comunicativa", answerability: "Clareza da resposta",
  pause_quality: "Qualidade da pausa", level_fit: "Adequação ao nível",
  distractor_quality: "Qualidade das alternativas", variety: "Variedade pedagógica"
};
type Challenge = {
  id: string;
  challengeNumber: number;
  rank?: number;
  pedagogicalScore?: number;
  scoreBreakdown?: PredictionScoreBreakdown;
  scoreEvidence?: PredictionScoreEvidence;
  cueId: string;
  cueNumber: number;
  type: "word" | "expression" | "dialogue";
  clipStartWord: number;
  pauseBeforeWord: number;
  answerWordStart: number;
  answerWordEnd: number;
  resumeAfterWord: number;
  clipStartMs: number;
  pauseAtMs: number;
  resumeAtMs: number;
  answerText: string;
  prompt: string;
  choices: Choice[];
  explanation: string;
  editorialRationale: string;
  status: "draft" | "approved" | "rejected";
};
type Materials = {
  contract: string;
  source_hash: string;
  media: { name: string };
  challenges: {
    id: string;
    type: Challenge["type"];
    clip_start_ms: number;
    pause_at_ms: number;
    resume_at_ms: number;
    prompt: string;
    choices: { id: string; text: string; is_correct: boolean }[];
    explanation: string;
  }[];
};
type Review = {
  contract: string;
  approval: "draft";
  source_hash: string;
  saved_at?: string | null;
  challenges: Challenge[];
  materials?: Materials;
};
type Props = {
  projectId: string;
  assetId: string;
  assetName: string;
  cues: Cue[];
  selectedCueIds: string[];
  sourceSignature: string;
  onClose: () => void;
  onPreview: (startMs: number, endMs: number) => void;
  onPreviewModeChange: (active: boolean) => void;
  onDemoSeekAndPlay: (timeMs: number) => void;
  onDemoPause: () => void;
  onDemoResume: (timeMs: number) => void;
  getCurrentTime: () => number;
  onProjectUpdated?: () => void;
  embedded?: boolean;
};

const OUTPUT_CONTRACT = "nova-generator-prediction-listening-output/1.0";
const REVIEW_CONTRACT = "nova-generator-prediction-listening-review/1.0";
const MATERIALS_CONTRACT = "nova-generator-prediction-listening-materials/1.0";
const normalize = (value: string) => (value.replace(/[’‘]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []).join(" ").toLowerCase();
const buildMaterials = (review: Review, assetName: string): Materials => ({
  contract: MATERIALS_CONTRACT,
  source_hash: review.source_hash,
  media: { name: assetName },
  challenges: review.challenges.filter(item => item.status === "approved").map(item => ({
    id: item.id,
    type: item.type,
    clip_start_ms: item.clipStartMs,
    pause_at_ms: item.pauseAtMs,
    resume_at_ms: item.resumeAtMs,
    prompt: item.prompt,
    choices: item.choices.map((choice, index) => ({
      id: item.id + "-choice-" + (index + 1),
      text: choice.text,
      is_correct: choice.is_correct
    })),
    explanation: item.explanation
  }))
});

export default function PredictionListening({
  projectId, assetId, assetName, cues, selectedCueIds, sourceSignature, onClose, onPreview,
  onPreviewModeChange, onDemoSeekAndPlay, onDemoPause, onDemoResume, getCurrentTime, onProjectUpdated, embedded = false
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [sourceHash, setSourceHash] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [demoState, setDemoState] = useState<"idle" | "playing" | "question" | "complete">("idle");
  const [demoIndex, setDemoIndex] = useState(0);
  const [demoFeedback, setDemoFeedback] = useState("");
  const [demoReplayCount, setDemoReplayCount] = useState(0);
  const [previewingChallenge, setPreviewingChallenge] = useState<Challenge | null>(null);
  const demoCallbacks = useRef({ onDemoPause, onDemoResume, getCurrentTime });
  demoCallbacks.current = { onDemoPause, onDemoResume, getCurrentTime };
  const previewCallbacks = useRef({ onDemoPause, getCurrentTime, onPreviewModeChange });
  previewCallbacks.current = { onDemoPause, getCurrentTime, onPreviewModeChange };

  const selectedSet = useMemo(() => new Set(selectedCueIds), [selectedCueIds]);
  const counts = useMemo(() => ({
    draft: review?.challenges.filter(item => item.status === "draft").length ?? 0,
    approved: review?.challenges.filter(item => item.status === "approved").length ?? 0,
    rejected: review?.challenges.filter(item => item.status === "rejected").length ?? 0
  }), [review]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [pkg, stored] = await Promise.all([
          invoke<Package>("prepare_prediction_listening_package", {
            projectId, assetId, cues, selectedCueIds, sourceSignature
          }),
          invoke<Review | null>("load_prediction_listening_result", { projectId, assetId })
        ]);
        if (!alive) return;
        setSourceHash(pkg.sourceHash);
        if (stored?.contract === REVIEW_CONTRACT && stored.source_hash === pkg.sourceHash) {
          const hydrated = { ...stored, materials: buildMaterials(stored, assetName) };
          setReview(hydrated);
          if (JSON.stringify(stored.materials) !== JSON.stringify(hydrated.materials)) {
            await invoke("save_prediction_listening_result", { projectId, assetId, result: hydrated });
          }
        } else if (stored) {
          setNotice("A transcrição ou a seleção do Shadowing mudou. O resultado anterior foi preservado, mas precisa ser gerado novamente.");
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [projectId, assetId, assetName, sourceSignature]);

  async function persist(next: Review) {
    const pending = { ...next, saved_at: null };
    const persisted = { ...pending, materials: buildMaterials(pending, assetName) };
    await invoke("save_prediction_listening_result", { projectId, assetId, result: persisted });
    setReview(persisted);
  }

  async function saveForMaterials() {
    if (!review || busy || loading) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const approved = review.challenges.filter(item => item.status === "approved");
      const next = { ...review, saved_at: new Date().toISOString() };
      const persisted = { ...next, materials: buildMaterials(next, assetName) };
      await invoke("save_prediction_listening_result", { projectId, assetId, result: persisted });
      await invoke("update_project_stage", { id: projectId, stage: "Prediction Listening" });
      onProjectUpdated?.();
      setReview(persisted);
      setNotice(approved.length
        ? `Prediction Listening salvo. ${approved.length} desafio(s) aprovado(s) disponíveis para aproveitamento nos cards Anki.`
        : "Prediction Listening salvo. Aprove desafios para incluí-los nos cards Anki.");
    } catch (e) {
      setError("Não foi possível salvar o Prediction Listening: " + String(e));
    } finally {
      setBusy(false);
    }
  }

  async function downloadInput() {
    if (busy || loading) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const pkg = await invoke<Package>("prepare_prediction_listening_package", {
        projectId, assetId, cues, selectedCueIds, sourceSignature
      });
      const content = pkg.files["prediction-listening-entrada.txt"];
      if (!content) throw new Error("O TXT de entrada não foi gerado.");
      const path = await save({
        title: "Salvar entrada do Prediction Listening",
        defaultPath: "prediction-listening-entrada.txt",
        filters: [{ name: "Arquivo de texto", extensions: ["txt"] }]
      });
      if (!path) return;
      await invoke("save_external_translation_package", {
        path,
        bytes: Array.from(new TextEncoder().encode(content))
      });
      setSourceHash(pkg.sourceHash);
      setNotice("TXT salvo. Envie o arquivo à IA externa e importe o JSON retornado.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importResult(file?: File) {
    if (!file) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.contract !== OUTPUT_CONTRACT) {
        throw new Error("Contrato não reconhecido. Importe o JSON gerado a partir do TXT do Prediction Listening.");
      }
      if (typeof parsed.source_hash !== "string" || parsed.source_hash !== sourceHash) {
        throw new Error("O SOURCE_HASH não corresponde ao TXT atual. Gere ou baixe novamente a entrada antes de importar.");
      }
      if (!Array.isArray(parsed.challenges) || parsed.challenges.length > 8) {
        throw new Error("O JSON precisa conter no máximo 8 desafios ranqueados. Se não houver oportunidades fortes, use uma lista vazia.");
      }

      let nextWordNumber = 0;
      const wordByNumber = new Map<number, {
        cueId: string; cueNumber: number; text: string; startMs: number; endMs: number; selected: boolean;
      }>();
      cues.forEach((cue, cueIndex) => {
        if (cue.wordAlignment !== "whisperx" || !Array.isArray(cue.words)) return;
        cue.words.forEach(word => {
          nextWordNumber += 1;
          wordByNumber.set(nextWordNumber, {
            cueId: cue.id,
            cueNumber: cueIndex + 1,
            text: word.text,
            startMs: word.startMs,
            endMs: word.endMs,
            selected: selectedSet.has(cue.id)
          });
        });
      });

      const seenChallenges = new Set<number>();
      let previousScore = Number.POSITIVE_INFINITY;
      const tieBreakKeys: PredictionScoreKey[] = ["prediction_value", "contextual_fit", "communicative_value", "answerability"];
      let previousBreakdown: PredictionScoreBreakdown | null = null;
      const challenges: Challenge[] = parsed.challenges.map((item: any, index: number) => {
        const rank = Number(item?.rank);
        const pedagogicalScore = Number(item?.pedagogical_score);
        if (rank !== index + 1 || !Number.isInteger(rank)) throw new Error("O ranking deve ser sequencial, começando em 1, sem lacunas.");
        const rawBreakdown = item?.score_breakdown;
        const scoreKeys = Object.keys(PREDICTION_SCORE_WEIGHTS) as PredictionScoreKey[];
        if (!rawBreakdown || scoreKeys.some(key => !Number.isInteger(rawBreakdown[key]) || rawBreakdown[key] < 0 || rawBreakdown[key] > PREDICTION_SCORE_WEIGHTS[key])) {
          throw new Error("O desafio " + rank + " contém notas inválidas no score_breakdown.");
        }
        const scoreBreakdown = rawBreakdown as PredictionScoreBreakdown;
        const scoreTotal = scoreKeys.reduce((sum, key) => sum + scoreBreakdown[key], 0);
        if (!Number.isInteger(pedagogicalScore) || pedagogicalScore < 70 || pedagogicalScore > 100 || scoreTotal !== pedagogicalScore) {
          throw new Error("O desafio " + rank + " precisa atingir pelo menos 70 pontos e a soma dos critérios deve corresponder à nota final.");
        }
        const rawEvidence = item?.score_evidence;
        if (!rawEvidence || scoreKeys.some(key => typeof rawEvidence[key] !== "string" || !rawEvidence[key].trim())) {
          throw new Error("O desafio " + rank + " precisa justificar os oito critérios de pontuação.");
        }
        if (pedagogicalScore > previousScore) throw new Error("As recomendações precisam estar ordenadas da maior para a menor pontuação.");
        if (pedagogicalScore === previousScore && previousBreakdown) {
          const tieWinner = tieBreakKeys.find(key => scoreBreakdown[key] !== previousBreakdown![key]);
          if (tieWinner && scoreBreakdown[tieWinner] > previousBreakdown[tieWinner]) {
            throw new Error("O ranking não respeita os critérios de desempate pedagógico.");
          }
        }
        previousScore = pedagogicalScore;
        previousBreakdown = scoreBreakdown;
        const number = Number(item?.challenge_number);
        const cueNumber = Number(item?.cue_number);
        const type = String(item?.type ?? "");
        if (!Number.isInteger(number) || number < 1 || seenChallenges.has(number)) {
          throw new Error("Há números de desafio inválidos ou duplicados.");
        }
        seenChallenges.add(number);
        if (!["word", "expression", "dialogue"].includes(type)) {
          throw new Error("O desafio " + number + " usa um tipo não permitido.");
        }
        const clipStartWord = Number(item?.clip_start_word);
        const pauseBeforeWord = Number(item?.pause_before_word);
        const answerWordStart = Number(item?.answer_word_start);
        const answerWordEnd = Number(item?.answer_word_end);
        const resumeAfterWord = Number(item?.resume_after_word);
        const clipStart = wordByNumber.get(clipStartWord);
        const answerStart = wordByNumber.get(answerWordStart);
        const answerEnd = wordByNumber.get(answerWordEnd);
        if (!clipStart || !answerStart || !answerEnd) {
          throw new Error("O desafio " + number + " referencia uma palavra inexistente ou sem alinhamento WhisperX.");
        }
        if (!answerStart.selected || cueNumber !== answerStart.cueNumber) {
          throw new Error("O desafio " + number + " não está localizado em um bloco selecionado no Shadowing.");
        }
        if (clipStartWord > answerWordStart || pauseBeforeWord !== answerWordStart || resumeAfterWord !== answerWordEnd || answerWordEnd < answerWordStart) {
          throw new Error("O desafio " + number + " contém referências de pausa, resposta ou retomada inconsistentes.");
        }
        const answerWords: typeof answerStart[] = [];
        for (let wordNumber = answerWordStart; wordNumber <= answerWordEnd; wordNumber++) {
          const word = wordByNumber.get(wordNumber);
          if (!word || !word.selected) {
            throw new Error("A resposta do desafio " + number + " não corresponde a palavras alinhadas e selecionadas consecutivas.");
          }
          answerWords.push(word);
        }
        if (answerWords.length > 40 || clipStart.startMs > answerStart.startMs) {
          throw new Error("O desafio " + number + " possui um intervalo de reprodução inválido.");
        }
        for (let index = 1; index < answerWords.length; index++) {
          const previous = answerWords[index - 1];
          const currentWord = answerWords[index];
          if (currentWord.cueNumber < previous.cueNumber || currentWord.cueNumber > previous.cueNumber + 1) {
            throw new Error("A resposta do desafio " + number + " atravessa um trecho sem continuidade.");
          }
        }
        const answerText = answerWords.map(word => word.text).join(" ").trim();
        const prompt = String(item?.prompt ?? "").trim();
        const explanation = String(item?.explanation ?? "").trim();
        const editorialRationale = String(item?.editorial_rationale ?? "").trim();
        if (!prompt || !explanation || !editorialRationale) {
          throw new Error("O desafio " + number + " precisa conter prompt, explanation e editorial_rationale.");
        }
        if (!Array.isArray(item?.choices) || item.choices.length !== 4) {
          throw new Error("O desafio " + number + " precisa conter exatamente quatro alternativas.");
        }
        const choices: Choice[] = item.choices.map((choice: any) => ({
          text: String(choice?.text ?? "").trim(),
          is_correct: choice?.is_correct === true
        }));
        if (choices.some(choice => !choice.text) || new Set(choices.map(choice => normalize(choice.text))).size !== 4) {
          throw new Error("O desafio " + number + " contém alternativas vazias ou repetidas.");
        }
        if (choices.filter(choice => choice.is_correct).length !== 1) {
          throw new Error("O desafio " + number + " precisa ter exatamente uma alternativa correta.");
        }
        const correct = choices.find(choice => choice.is_correct)!;
        if (normalize(correct.text) !== normalize(answerText)) {
          throw new Error("A alternativa correta do desafio " + number + " não corresponde ao trecho original: \"" + answerText + "\".");
        }
        return {
          id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "prediction-" + Date.now() + "-" + index,
          challengeNumber: number,
          rank,
          pedagogicalScore,
          scoreBreakdown,
          scoreEvidence: rawEvidence as PredictionScoreEvidence,
          cueId: answerStart.cueId,
          cueNumber,
          type,
          clipStartWord,
          pauseBeforeWord,
          answerWordStart,
          answerWordEnd,
          resumeAfterWord,
          clipStartMs: clipStart.startMs,
          pauseAtMs: answerStart.startMs,
          resumeAtMs: answerEnd.endMs,
          answerText,
          prompt,
          choices,
          explanation,
          editorialRationale,
          status: "draft"
        };
      });

      const next: Review = {
        contract: REVIEW_CONTRACT,
        approval: "draft",
        source_hash: sourceHash,
        challenges
      };
      await persist(next);
      setNotice(challenges.length
        ? challenges.length + " desafio(s) importado(s) como rascunho. Revise e aprove individualmente."
        : "A IA não encontrou oportunidades fortes de previsão. O resultado vazio foi registrado.");
    } catch (e) {
      setError("Falha ao importar JSON: " + String(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function changeStatus(id: string, status: Challenge["status"]) {
    if (!review || busy) return;
    setBusy(true); setError("");
    try {
      const next = { ...review, challenges: review.challenges.map(item => item.id === id ? { ...item, status } : item) };
      await persist(next);
      setNotice(status === "approved" ? "Desafio aprovado." : status === "rejected" ? "Desafio rejeitado." : "Desafio voltou para revisão.");
    } catch (e) {
      setError("Não foi possível salvar a revisão: " + String(e));
    } finally {
      setBusy(false);
    }
  }

  const approvedChallenges = useMemo(
    () => (review?.challenges ?? []).filter(item => item.status === "approved").slice().sort((a, b) => a.pauseAtMs - b.pauseAtMs),
    [review]
  );
  const activeDemoChallenge = approvedChallenges[demoIndex] ?? null;

  function previewChallenge(challenge: Challenge) {
    if (busy || loading || demoState !== "idle") return;
    setPreviewingChallenge(challenge);
    onPreviewModeChange(true);
    onPreview(challenge.clipStartMs, challenge.resumeAtMs);
  }

  function stopChallengePreview() {
    onDemoPause();
    setPreviewingChallenge(null);
    onPreviewModeChange(false);
  }

  useEffect(() => {
    if (!previewingChallenge) return;
    let frame = 0;
    const tick = () => {
      if (previewCallbacks.current.getCurrentTime() >= previewingChallenge.resumeAtMs) {
        previewCallbacks.current.onDemoPause();
        setPreviewingChallenge(null);
        previewCallbacks.current.onPreviewModeChange(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [previewingChallenge]);

  function startDemo() {
    if (!approvedChallenges.length || busy || loading || previewingChallenge) return;
    setDemoIndex(0);
    setDemoFeedback("");
    setDemoReplayCount(0);
    setDemoState("playing");
    onDemoSeekAndPlay(approvedChallenges[0].clipStartMs);
  }

  function stopDemo() {
    onDemoPause();
    onPreviewModeChange(false);
    setDemoState("idle");
    setDemoFeedback("");
  }

  function answerDemo(choice: Choice) {
    const challenge = activeDemoChallenge;
    if (!challenge || demoState !== "question") return;
    if (!choice.is_correct) {
      setDemoFeedback("Ainda não. O vídeo continua pausado. Você pode ouvir o trecho novamente.");
      return;
    }
    setDemoFeedback("Correto! Continuando a reprodução...");
    const nextIndex = demoIndex + 1;
    setDemoIndex(nextIndex);
    if (nextIndex >= approvedChallenges.length) {
      setDemoState("complete");
      onDemoResume(challenge.resumeAtMs);
      return;
    }
    setDemoState("playing");
    onDemoResume(challenge.resumeAtMs);
  }

  function replayDemoSegment() {
    if (!activeDemoChallenge || demoState !== "question") return;
    setDemoFeedback("Ouça novamente o trecho antes de responder.");
    setDemoReplayCount(value => value + 1);
    setDemoState("playing");
    onDemoSeekAndPlay(activeDemoChallenge.clipStartMs);
  }

  useEffect(() => {
    if (demoState !== "playing") return;
    let frame = 0;
    let lastCheck = 0;
    const tick = (now: number) => {
      if (now - lastCheck >= 25) {
        lastCheck = now;
        const challenge = approvedChallenges[demoIndex];
        if (!challenge) {
          setDemoState("complete");
          return;
        }
        if (demoCallbacks.current.getCurrentTime() >= challenge.pauseAtMs) {
          demoCallbacks.current.onDemoPause();
          setDemoState("question");
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [demoState, demoIndex, approvedChallenges]);

  useEffect(() => () => {
    demoCallbacks.current.onDemoPause();
    onPreviewModeChange(false);
  }, []);

  return <div className={"prediction-listening-backdrop" + (embedded ? " embedded" : "") + (demoState !== "idle" ? " demo-active" : "")}>
    <section className="prediction-listening-modal" role="dialog" aria-modal={!embedded} aria-label="Prediction Listening">
      <header className="prediction-listening-header">
        <div>
          <span className="eyebrow">CONTEÚDO PEDAGÓGICO</span>
          <h2>Prediction Listening</h2>
          <p>{assetName}</p>
        </div>
        <button className="icon-button" title="Fechar" onClick={() => { if (demoState !== "idle") onDemoPause(); onClose(); }}><X size={18}/></button>
      </header>
      <div className="prediction-listening-toolbar">
        <button className="primary-button" onClick={startDemo} disabled={busy || loading || approvedChallenges.length === 0 || demoState !== "idle"} title={approvedChallenges.length === 0 ? "Aprove ao menos um desafio para testar" : "Executar a experiência do aluno"}><PlayCircle size={15}/> Testar experiência</button>
        <button className="secondary-button" onClick={() => void downloadInput()} disabled={busy || loading}>
          <FileText size={15}/>{busy ? "Processando..." : "Baixar TXT para IA"}
        </button>
        <button className="secondary-button" onClick={() => fileInput.current?.click()} disabled={busy || loading || !sourceHash}>
          <FileJson size={15}/> Importar JSON
        </button>
        <button className="primary-button" onClick={() => void saveForMaterials()} disabled={!review || busy || loading || Boolean(review?.saved_at)} title={review?.saved_at ? "Este resultado já foi salvo" : "Salvar o resultado do Prediction Listening"}>
          <Save size={15}/>{review?.saved_at ? "Salvo" : "Salvar"}
        </button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => void importResult(event.target.files?.[0])}/>
      </div>
      {error && <div className="prediction-listening-feedback error">{error}</div>}
      {notice && <div className="prediction-listening-feedback">{notice}</div>}
      <div className="prediction-listening-summary">
        <span><b>{counts.draft}</b> aguardando revisão</span>
        <span><b>{counts.approved}</b> aprovados</span>
        <span><b>{counts.rejected}</b> rejeitados</span>
        {sourceHash && <small>HASH {sourceHash}</small>}
        {review?.saved_at && <small className="prediction-materials-saved">SALVO PARA MATERIAIS</small>}
      </div>
      {previewingChallenge && <section className="prediction-demo-panel prediction-preview-panel" aria-live="polite">
        <div className="prediction-demo-topline"><span>PRÉVIA DO TRECHO</span><button className="icon-button" title="Fechar prévia" onClick={stopChallengePreview}><X size={16}/></button></div>
        <h2>{previewingChallenge.prompt}</h2>
        <p className="prediction-demo-feedback">O vídeo está reproduzindo o trecho original, incluindo a fala que completa o desafio.</p>
        <div className="prediction-demo-progress"><span>Desafio {previewingChallenge.challengeNumber}</span><span>{previewingChallenge.clipStartMs} ms → {previewingChallenge.resumeAtMs} ms</span></div>
      </section>}
      {demoState !== "idle" && <section className="prediction-demo-panel" aria-live="polite">
        <div className="prediction-demo-topline">
          <span>SIMULAÇÃO DO ALUNO</span>
          <button className="icon-button" title="Parar teste" onClick={stopDemo}><X size={16}/></button>
        </div>
        {demoState === "playing" && <div className="prediction-demo-waiting">
          <RefreshCw size={22}/>
          <strong>Reproduzindo trecho...</strong>
          <span>O desafio {activeDemoChallenge?.challengeNumber ?? ""} será apresentado no ponto de previsão.</span>
        </div>}
        {demoState === "question" && activeDemoChallenge && <>
          <span className="prediction-demo-eyebrow">LISTENING CHECKPOINT · {activeDemoChallenge.type.toUpperCase()}</span>
          <h2>{activeDemoChallenge.prompt}</h2>
          <div className="prediction-demo-choices">
            {activeDemoChallenge.choices.map((choice, index) => <button key={index} onClick={() => answerDemo(choice)}>
              <span>{String.fromCharCode(65 + index)}</span>{choice.text}
            </button>)}
          </div>
          {demoFeedback && <p className="prediction-demo-feedback">{demoFeedback}</p>}
          <button className="secondary-button prediction-demo-replay" onClick={replayDemoSegment}><RotateCcw size={14}/> Ouvir trecho novamente</button>
          <small>O vídeo está pausado até a resposta correta.</small>
        </>}
        {demoState === "complete" && <div className="prediction-demo-waiting">
          <Check size={26}/>
          <strong>Experiência concluída!</strong>
          <span>Todos os {approvedChallenges.length} desafios aprovados foram testados.</span>
          <button className="primary-button" onClick={startDemo}><RotateCcw size={14}/> Repetir teste</button>
          <button className="secondary-button" onClick={stopDemo}>Voltar à revisão</button>
        </div>}
        <div className="prediction-demo-progress"><span>Desafio {Math.min(demoIndex + (demoState === "complete" ? 0 : 1), approvedChallenges.length)} de {approvedChallenges.length}</span><span>{demoReplayCount ? `Reproduções extras: ${demoReplayCount}` : "Fluxo do iHubEnglish"}</span></div>
      </section>}
      <main className="prediction-listening-content">
        {loading ? <div className="prediction-listening-empty"><RefreshCw size={18}/> Preparando módulo...</div>
          : !review?.challenges.length ? <div className="prediction-listening-empty">
            <FileText size={25}/>
            <strong>Nenhum desafio importado</strong>
            <span>Baixe o TXT, envie para uma IA externa e importe o JSON de resposta.</span>
          </div>
          : review.challenges.map(challenge => <article className={"prediction-challenge " + challenge.status} key={challenge.id}>
            <div className="prediction-challenge-heading">
              <div><span className="prediction-challenge-type">#{challenge.rank ?? challenge.challengeNumber} · {challenge.type.toUpperCase()}</span><strong>Desafio {challenge.challengeNumber}</strong></div>
              {challenge.pedagogicalScore != null && <strong className="prediction-challenge-score">{challenge.pedagogicalScore}/100</strong>}
              <span className={"prediction-challenge-status " + challenge.status}>{challenge.status === "approved" ? "Aprovado" : challenge.status === "rejected" ? "Rejeitado" : "Em revisão"}</span>
            </div>
            <h3>{challenge.prompt}</h3>
            <div className="prediction-challenge-choices">
              {challenge.choices.map((choice, index) => <div className={choice.is_correct ? "correct" : ""} key={index}>
                <span>{String.fromCharCode(65 + index)}</span><p>{choice.text}</p>{choice.is_correct && <small>Resposta correta</small>}
              </div>)}
            </div>
            <div className="prediction-challenge-answer"><b>Trecho original:</b> {challenge.answerText}</div>
            <div className="prediction-challenge-explanation"><b>Explicação ao aluno:</b> {challenge.explanation}</div>
            <div className="prediction-challenge-rationale"><b>Justificativa editorial:</b> {challenge.editorialRationale}</div>
            {challenge.scoreBreakdown && challenge.scoreEvidence && <details className="prediction-challenge-scoring"><summary>Ver pontuação pedagógica</summary>
              <div>{(Object.keys(PREDICTION_SCORE_WEIGHTS) as PredictionScoreKey[]).map(key => <p key={key}><strong>{PREDICTION_SCORE_LABELS[key]} · {challenge.scoreBreakdown![key]}/{PREDICTION_SCORE_WEIGHTS[key]}</strong><span>{challenge.scoreEvidence![key]}</span></p>)}</div>
            </details>}
            <footer>
              <span>Início {challenge.clipStartMs} ms · Pausa {challenge.pauseAtMs} ms · Retomada {challenge.resumeAtMs} ms</span>
              <button className="secondary-button" onClick={() => previewChallenge(challenge)} disabled={Boolean(previewingChallenge) || demoState !== "idle"}><PlayCircle size={14}/> Pré-visualizar trecho</button>
              {challenge.status !== "approved" && <button className="primary-button" onClick={() => void changeStatus(challenge.id, "approved")} disabled={busy}>Aprovar</button>}
              {challenge.status !== "rejected" && <button className="secondary-button" onClick={() => void changeStatus(challenge.id, "rejected")} disabled={busy}>Rejeitar</button>}
              {challenge.status !== "draft" && <button className="secondary-button" onClick={() => void changeStatus(challenge.id, "draft")} disabled={busy}>Revisar novamente</button>}
            </footer>
          </article>)}
      </main>
    </section>
  </div>;
}
