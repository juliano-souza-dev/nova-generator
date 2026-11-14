import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, Download, FileJson, FileText, RefreshCw, X } from "lucide-react";
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
type Challenge = {
  id: string;
  challengeNumber: number;
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
type Review = {
  contract: string;
  approval: "draft";
  source_hash: string;
  challenges: Challenge[];
};
type Props = {
  projectId: string;
  assetId: string;
  assetName: string;
  cues: Cue[];
  selectedCueIds: string[];
  onClose: () => void;
  onPreview: (timeMs: number) => void;
};

const OUTPUT_CONTRACT = "nova-generator-prediction-listening-output/1.0";
const REVIEW_CONTRACT = "nova-generator-prediction-listening-review/1.0";
const MATERIALS_CONTRACT = "nova-generator-prediction-listening-materials/1.0";
const normalize = (value: string) => (value.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).join(" ").toLowerCase();

export default function PredictionListening({
  projectId, assetId, assetName, cues, selectedCueIds, onClose, onPreview
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [sourceHash, setSourceHash] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

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
            projectId, assetId, cues, selectedCueIds
          }),
          invoke<Review | null>("load_prediction_listening_result", { projectId, assetId })
        ]);
        if (!alive) return;
        setSourceHash(pkg.sourceHash);
        if (stored?.contract === REVIEW_CONTRACT && stored.source_hash === pkg.sourceHash) {
          setReview(stored);
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
  }, [projectId, assetId]);

  async function persist(next: Review) {
    await invoke("save_prediction_listening_result", { projectId, assetId, result: next });
    setReview(next);
  }

  async function downloadInput() {
    if (busy || loading) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const pkg = await invoke<Package>("prepare_prediction_listening_package", {
        projectId, assetId, cues, selectedCueIds
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
      if (!Array.isArray(parsed.challenges) || parsed.challenges.length > 100) {
        throw new Error("O JSON precisa conter uma lista válida com no máximo 100 desafios.");
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
      const challenges: Challenge[] = parsed.challenges.map((item: any, index: number) => {
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

  async function exportApproved() {
    if (!review || busy) return;
    const approved = review.challenges.filter(item => item.status === "approved");
    if (!approved.length) {
      setError("Aprove ao menos um desafio antes de exportar.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const output = {
        contract: MATERIALS_CONTRACT,
        source_hash: review.source_hash,
        media: { name: assetName },
        challenges: approved.map(item => ({
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
      };
      const path = await save({
        title: "Exportar Prediction Listening aprovado",
        defaultPath: "prediction-listening-aprovados.json",
        filters: [{ name: "Arquivo JSON", extensions: ["json"] }]
      });
      if (!path) return;
      await invoke("save_prediction_listening_export", {
        path,
        bytes: Array.from(new TextEncoder().encode(JSON.stringify(output, null, 2)))
      });
      setNotice(approved.length + " desafio(s) aprovado(s) exportado(s).");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return <div className="prediction-listening-backdrop">
    <section className="prediction-listening-modal" role="dialog" aria-modal="true" aria-label="Prediction Listening">
      <header className="prediction-listening-header">
        <div>
          <span className="eyebrow">NOVA GENERATOR · MÓDULO EDITORIAL</span>
          <h2>Prediction Listening</h2>
          <p>{assetName} · {selectedCueIds.length} blocos concluídos no Shadowing</p>
        </div>
        <button className="icon-button" title="Fechar" onClick={onClose}><X size={18}/></button>
      </header>
      <div className="prediction-listening-toolbar">
        <div className="prediction-listening-prerequisite"><Check size={15}/> Shadowing concluído</div>
        <button className="secondary-button" onClick={() => void downloadInput()} disabled={busy || loading}>
          <FileText size={15}/>{busy ? "Processando..." : "Baixar TXT para IA"}
        </button>
        <button className="secondary-button" onClick={() => fileInput.current?.click()} disabled={busy || loading || !sourceHash}>
          <FileJson size={15}/> Importar JSON
        </button>
        <button className="primary-button" onClick={() => void exportApproved()} disabled={busy || loading || counts.approved === 0}>
          <Download size={15}/> Exportar aprovados ({counts.approved})
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
      </div>
      <main className="prediction-listening-content">
        {loading ? <div className="prediction-listening-empty"><RefreshCw size={18}/> Preparando módulo...</div>
          : !review?.challenges.length ? <div className="prediction-listening-empty">
            <FileText size={25}/>
            <strong>Nenhum desafio importado</strong>
            <span>Baixe o TXT, envie para uma IA externa e importe o JSON de resposta.</span>
          </div>
          : review.challenges.map(challenge => <article className={"prediction-challenge " + challenge.status} key={challenge.id}>
            <div className="prediction-challenge-heading">
              <div><span className="prediction-challenge-type">{challenge.type.toUpperCase()}</span><strong>Desafio {challenge.challengeNumber}</strong></div>
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
            <footer>
              <span>Início {challenge.clipStartMs} ms · Pausa {challenge.pauseAtMs} ms · Retomada {challenge.resumeAtMs} ms</span>
              <button className="secondary-button" onClick={() => onPreview(challenge.pauseAtMs)}>Ver momento</button>
              {challenge.status !== "approved" && <button className="primary-button" onClick={() => void changeStatus(challenge.id, "approved")} disabled={busy}>Aprovar</button>}
              {challenge.status !== "rejected" && <button className="secondary-button" onClick={() => void changeStatus(challenge.id, "rejected")} disabled={busy}>Rejeitar</button>}
              {challenge.status !== "draft" && <button className="secondary-button" onClick={() => void changeStatus(challenge.id, "draft")} disabled={busy}>Revisar novamente</button>}
            </footer>
          </article>)}
      </main>
    </section>
  </div>;
}
