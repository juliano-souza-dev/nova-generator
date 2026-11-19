import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { AudioLines, Check, ChevronDown, ChevronRight, Download, FileText, LoaderCircle, Sparkles, Volume2 } from "lucide-react";
import { runTrackedTask } from "../tasks/TaskCenter";
import {
  buildSmartLearningSource, SMART_LEARNING_MOMENTS_CONTRACT, SMART_LEARNING_SCORE_WEIGHTS,
  validateSmartLearningMoments, type SmartLearningMomentsPackage, type SmartLearningCandidate
} from "./smart-learning-moments-contract";
import type { SmartLearningCue } from "./smart-learning-moments-contract";
import "./SmartLearningMoments.css";

type Props = {
  projectId: string;
  assetId: string;
  sourceSignature: string;
  cues: SmartLearningCue[];
  translations: { id: string; text: string }[];
  value: SmartLearningMomentsPackage | null;
  onChange: (value: SmartLearningMomentsPackage | null) => void;
};
type Voice = { id: string; name: string };
type AudioResult = { cardId: string; audioPath: string; language: string; speaker: string };

const scoreLabels: Record<keyof typeof SMART_LEARNING_SCORE_WEIGHTS, string> = {
  transferability: "Transferência para outros contextos",
  communicative_utility: "Utilidade comunicativa",
  instructional_value: "Valor instrucional",
  scene_relevance: "Relevância na cena",
  comprehension_potential: "Potencial de compreensão",
  level_fit: "Adequação ao nível",
  explanation_clarity: "Clareza da explicação",
  retention: "Retenção e memorização"
};

export default function SmartLearningMoments({ projectId, assetId, sourceSignature, cues, translations, value, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [voiceReady, setVoiceReady] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioCandidateId, setAudioCandidateId] = useState("");

  const selected = useMemo(() => value?.candidates.find(item => item.id === value.final_selection) ?? null, [value]);
  const includedAudioCount = selected?.audio_assets?.length ?? 0;

  useEffect(() => {
    void invoke<any>("get_shared_runtime_status").then(status => {
      const available = Array.isArray(status?.voices) ? status.voices as Voice[] : [];
      setVoices(available);
      setVoiceId(status?.defaultVoiceId && available.some(item => item.id === status.defaultVoiceId) ? status.defaultVoiceId : available[0]?.id ?? "");
      setVoiceReady(Boolean(status?.voiceCloningReady && available.length));
    }).catch(() => { setVoices([]); setVoiceReady(false); });
  }, []);

  async function createInstructions() {
    if (!cues.length || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const source = buildSmartLearningSource(projectId, assetId, sourceSignature, cues, translations);
      const sourceHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source)));
      const hash = Array.from(new Uint8Array(sourceHash)).map(byte => byte.toString(16).padStart(2, "0")).join("");
      const weights = Object.entries(SMART_LEARNING_SCORE_WEIGHTS).map(([key, weight]) => key + ": " + weight + " points").join("\\r\\n");
      const template = {
        contract: SMART_LEARNING_MOMENTS_CONTRACT,
        source_hash: hash,
        recommendation_status: "recommended",
        selection_limit: 1,
        candidates: [{
          id: "moment_001", rank: 1, pedagogical_score: 94,
          score_breakdown: { transferability: 20, communicative_utility: 15, instructional_value: 14, scene_relevance: 15, comprehension_potential: 9, level_fit: 9, explanation_clarity: 8, retention: 4 },
          score_evidence: Object.fromEntries(Object.keys(SMART_LEARNING_SCORE_WEIGHTS).map(key => [key, "Evidence from the transcript and communicative context."])),
          recommendation_reason: "Explain why this is the strongest teachable opportunity.",
          category: "conversational_expression", level: "beginner",
          source: { cue_id: "exact-cue-id", cue_order: 1, start_ms: 0, end_ms: 2500, expression: "You know what we should do?", excerpt_en: "You know what we should do?", excerpt_pt: "Sabe o que a gente deveria fazer?" },
          lesson: {
            title: "Introducing suggestions",
            meaning_pt: "Significado contextual em português brasileiro.",
            communicative_intent_pt: "O que o falante pretende fazer ao usar a expressão.",
            explanation_pt: "Explique forma, significado, intenção, registro e por que funciona nesta cena.",
            examples: [
              { context: "Making a suggestion", en: "You know what we could try?", pt: "Sabe o que poderíamos tentar?" },
              { context: "Introducing an idea", en: "You know what? Let's go.", pt: "Quer saber? Vamos embora." }
            ],
            context_tree: [{
              id: "suggestions", title: "Dar sugestões", purpose: "Apresentar uma ideia ou proposta.",
              examples: [{ context: "Planning", en: "You know what we should do?", pt: "Sabe o que a gente deveria fazer?" }]
            }, {
              id: "new-idea", title: "Introduzir uma ideia", purpose: "Chamar a atenção antes de compartilhar uma ideia.",
              examples: [{ context: "Decision", en: "You know what? Let's try again.", pt: "Quer saber? Vamos tentar de novo." }]
            }],
            narration: {
              estimated_duration_seconds: 45,
              voice_direction: "Natural, conversational teacher. Warm but restrained. Short phrases, clear articulation, no exaggerated enthusiasm.",
              segments: [
                { id: "opening", language: "pt", purpose: "opening", text: "Você acabou de ouvir uma expressão muito interessante." },
                { id: "explanation", language: "pt", purpose: "explanation", text: "Ela é usada para chamar a atenção da outra pessoa antes de apresentar uma ideia ou sugestão. Não é uma pergunta literal sobre o que alguém sabe. É uma forma natural de preparar o que vem a seguir." },
                { id: "example-1", language: "en", purpose: "example", text: "You know what we could try?" },
                { id: "example-1-pt", language: "pt", purpose: "example", text: "Sabe o que poderíamos tentar?" },
                { id: "closing", language: "pt", purpose: "closing", text: "Perceba como a expressão ajuda a introduzir uma proposta de maneira natural." }
              ]
            }
          }
        }]
      };
      const lines = [
        "NOVA GENERATOR | SMART LEARNING MOMENTS",
        "EXTERNAL AI INSTRUCTIONS | VERSION 1.0",
        "OUTPUT_CONTRACT: " + SMART_LEARNING_MOMENTS_CONTRACT,
        "SOURCE_HASH: " + hash,
        "PROJECT_ID: " + projectId,
        "ASSET_ID: " + assetId,
        "CANDIDATE_LIMIT: 8",
        "FINAL_SELECTION_LIMIT: 1",
        "TIMING_UNIT: milliseconds from the beginning of the selected video asset",
        "",
        "MISSION",
        "Analyze the complete reviewed transcript and identify the strongest single teachable moment for an in-video micro-lesson. Return 3 to 5 ranked candidates when enough high-quality opportunities exist. Return fewer when appropriate. Never invent candidates to fill a quota. If no candidate reaches 70/100 and passes every rejection rule, return recommendation_status=no_recommendation and candidates=[].",
        "",
        "PEDAGOGICAL SCORING SYSTEM (maximum 100 points)",
        weights,
        "Each criterion score must be between zero and its maximum weight. The total must equal the sum of all eight scores. Provide a specific evidence sentence for every criterion, grounded in the transcript and communicative situation.",
        "1. transferability: can learners reuse this construction across genuinely different situations?",
        "2. communicative_utility: how useful and frequent is it in everyday communication?",
        "3. instructional_value: does it reveal a meaningful pattern, pragmatic intention, grammar, collocation, idiom, or useful nuance?",
        "4. scene_relevance: is the moment meaningful in this exact scene and worth pausing for?",
        "5. comprehension_potential: can the explanation create a genuine insight beyond literal translation?",
        "6. level_fit: is it accessible yet valuable for the target learner level? Assume beginner unless source metadata says otherwise.",
        "7. explanation_clarity: can it be taught clearly in a 20–90 second mini lesson?",
        "8. retention: is there a memorable pattern or contrast that helps learners retain and reuse it?",
        "",
        "HARD REJECTION RULES",
        "Reject content with uncertain transcript evidence, incorrect or ambiguous interpretation, trivial literal translation only, low transfer value, redundancy, unnatural examples, excessive dependence on this one scene, or a source span that cannot be timed exactly. Do not recommend below 70 points. Rank by total score descending; break ties by transferability, then communicative_utility, then instructional_value.",
        "",
        "SOURCE AND TIMING",
        "Select an exact expression heard in one cue. Copy cue_id, cue_order, start_ms and end_ms exactly. Do not estimate, shift, round, or invent timing. The video pauses at the selected cue start. excerpt_en must be an exact substring of text_en and contain expression. excerpt_pt may use the supplied translation but must not change source meaning.",
        "",
        "LESSON DESIGN",
        "Create a self-contained mini lesson designed to appear inside the video while the original video is paused. Teach what the speaker means, the communicative intention, why this construction is used, and how the learner can reuse it. Do not merely translate. Keep the visible lesson concise. Provide at least two natural examples with Brazilian Portuguese translations and at least two genuinely different context-tree branches. Each branch must explain a different communicative situation, not just swap nouns.",
        "",
        "NARRATION FOR NATURAL TTS",
        "Write narration as a human teacher speaking naturally, not as an article. Use short spoken sentences, clear transitions, and a conversational rhythm. Avoid generic openings such as 'Today we are going to learn'. No stage directions, bracketed pauses, markdown, bullet symbols, pronunciation respellings, or production notes inside spoken text. Put voice direction in voice_direction only. Split narration into short segments, each tagged pt or en. English example segments must remain in English; Portuguese explanation segments must remain in Brazilian Portuguese. Aim for 30–60 seconds, hard range 20–90 seconds. Do not duplicate all on-screen text word for word.",
        "",
        "OUTPUT",
        "Return ONLY valid JSON. No markdown, no commentary. Use the exact field names and shape below. score_breakdown values must add up exactly to pedagogical_score. score_evidence must contain all eight keys. Candidate array must be sorted from best to worst. Set selected=false or omit selected. final_selection must be null; the human curator selects later.",
        JSON.stringify(template, null, 2),
        "",
        "REVIEWED TRANSCRIPT",
        JSON.stringify(source, null, 2)
      ];
      const path = await saveFile({ title: "Salvar instruções Smart Learning Moments", defaultPath: "smart-learning-moments-" + assetId + ".txt", filters: [{ name: "Instruções para IA externa", extensions: ["txt"] }] });
      if (!path) return;
      await runTrackedTask("materials", "Salvar instruções Smart Learning Moments", () =>
        invoke("save_external_translation_package", { path, bytes: Array.from(new TextEncoder().encode("\\uFEFF" + lines.join("\\r\\n"))) })
      );
      setNotice("Instruções TXT salvas. A IA deverá classificar as melhores oportunidades e preparar mini aulas com roteiro de narração.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function importCandidates(file?: File) {
    if (!file || busy) return;
    setBusy(true); setError(""); setNotice(""); setFileName(file.name);
    try {
      await runTrackedTask("materials", "Validar candidatas Smart Learning Moments", async () => {
        if (file.size > 8 * 1024 * 1024) throw new Error("O JSON excede o limite de 8 MB.");
        const parsed = JSON.parse(await file.text()) as SmartLearningMomentsPackage;
        const source = buildSmartLearningSource(projectId, assetId, sourceSignature, cues, translations);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source)));
        const hash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
        const errors = validateSmartLearningMoments(parsed, hash, cues);
        if (errors.length) throw new Error(errors.join("\\n"));
        onChange({ ...parsed, candidates: parsed.candidates.map(candidate => ({ ...candidate, selected: false })), final_selection: null });
      });
      setNotice(parsedNotice(file.name));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function selectCandidate(id: string) {
    if (!value) return;
    onChange({ ...value, final_selection: value.final_selection === id ? null : id,
      candidates: value.candidates.map(candidate => ({ ...candidate, selected: value.final_selection !== id && candidate.id === id })) });
  }

  function toggleExpanded(id: string) {
    setExpanded(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }

  async function prepareElevenLabsScript(candidate: SmartLearningCandidate) {
    const segments = candidate.lesson.narration.segments;
    const content = [
      "SMART LEARNING MOMENT | ELEVENLABS VOICE SCRIPT",
      "TITLE: " + candidate.lesson.title,
      "VOICE DIRECTION: " + candidate.lesson.narration.voice_direction,
      "ESTIMATED DURATION: " + candidate.lesson.narration.estimated_duration_seconds + " seconds",
      "INSTRUCTIONS: Generate each segment separately. Preserve the language of each segment. Use a natural conversational teacher delivery. Do not read segment IDs, language labels, or purpose labels.",
      "",
      ...segments.flatMap((segment, index) => ["[SEGMENT " + String(index + 1).padStart(2, "0") + "]", "ID: " + segment.id, "LANGUAGE: " + segment.language, "PURPOSE: " + segment.purpose, segment.text, ""])
    ].join("\\r\\n");
    const path = await saveFile({ title: "Salvar roteiro de narração para ElevenLabs", defaultPath: "elevenlabs-" + candidate.id + "-roteiro.txt", filters: [{ name: "Roteiro de narração", extensions: ["txt"] }] });
    if (!path) return;
    await invoke("save_external_translation_package", { path, bytes: Array.from(new TextEncoder().encode("\\uFEFF" + content)) });
    setNotice("Roteiro segmentado salvo para geração no ElevenLabs. Gere cada segmento separadamente para preservar idioma e sincronização.");
  }

  async function generateInternalAudio(candidate: SmartLearningCandidate) {
    if (!voiceReady || !voiceId || audioBusy) return;
    setAudioBusy(true); setAudioCandidateId(candidate.id); setError(""); setNotice("");
    try {
      const requests = candidate.lesson.narration.segments.map(segment => ({
        cardId: candidate.id + ":" + segment.id,
        text: segment.text,
        language: segment.language === "pt" ? "Portuguese" : "English"
      }));
      const results = await runTrackedTask("materials", "Gerar áudio da mini aula", () =>
        invoke<AudioResult[]>("generate_material_audio", { projectId, assetId, voiceId, requests })
      );
      const audioAssets = results.map(result => ({
        segment_id: result.cardId.slice(candidate.id.length + 1),
        language: result.language,
        audio_path: result.audioPath,
        provider: "internal" as const
      }));
      onChange({ ...value!, candidates: value!.candidates.map(item => item.id === candidate.id ? { ...item, audio_assets: audioAssets } : item) });
      setNotice("Áudios internos gerados para " + audioAssets.length + " segmentos da mini aula.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setAudioBusy(false); setAudioCandidateId(""); }
  }

  return <section className="slm-workspace">
    <header className="slm-header">
      <div><span className="eyebrow">MÓDULO PEDAGÓGICO · SMART LEARNING MOMENTS</span><h3>Mini aulas no momento certo</h3><p>A IA encontra oportunidades de alto valor pedagógico. Você escolhe no máximo uma para interromper o vídeo e ensinar dentro da própria cena.</p></div>
      <div className="slm-actions">
        <button type="button" className="primary-button" onClick={() => void createInstructions()} disabled={!cues.length || busy}><FileText size={15}/> Baixar instruções TXT</button>
        <label className="secondary-button slm-upload"><Download size={15}/> Importar JSON<input type="file" accept=".json,application/json" hidden disabled={busy} onChange={event => void importCandidates(event.target.files?.[0])}/></label>
      </div>
    </header>
    <div className="slm-score-guide">
      <strong><Sparkles size={15}/> Sistema de peso pedagógico · 100 pontos</strong>
      <div>{Object.entries(SMART_LEARNING_SCORE_WEIGHTS).map(([key, weight]) => <span key={key}>{scoreLabels[key as keyof typeof scoreLabels]} <b>{weight}</b></span>)}</div>
      <small>As notas precisam ser justificadas por evidências da transcrição. Abaixo de 70 pontos, a candidata é descartada.</small>
    </div>
    {busy && <div className="slm-processing"><LoaderCircle className="spin" size={17}/> {fileName ? "Validando " + fileName : "Preparando instruções..."}</div>}
    {error && <div className="materials-alert error">{error}</div>}
    {notice && <div className="materials-alert success">{notice}</div>}
    {!value ? <div className="slm-empty"><Sparkles size={23}/><strong>Nenhuma análise importada</strong><p>Baixe o TXT e envie à IA externa. Ela retornará as melhores oportunidades de mini aula, com ranking, pontuação, explicação, exemplos e roteiro de voz.</p></div> : value.recommendation_status === "no_recommendation" ? <div className="slm-empty"><Check size={23}/><strong>Nenhuma oportunidade atingiu o padrão mínimo</strong><p>A IA não encontrou uma candidata com força pedagógica suficiente. O vídeo seguirá sem interrupção didática.</p></div> : <>
      <div className="slm-results-heading"><div><h4>Oportunidades identificadas</h4><p>Selecione somente uma. A pontuação é uma recomendação, não uma aprovação automática.</p></div><strong>{value.candidates.length} candidatas</strong></div>
      <div className="slm-candidates">{value.candidates.map(candidate => {
        const isSelected = value.final_selection === candidate.id;
        const isExpanded = expanded.includes(candidate.id);
        return <article className={"slm-candidate" + (isSelected ? " selected" : "")} key={candidate.id}>
          <header><span className="slm-rank">#{candidate.rank}</span><div className="slm-candidate-title"><strong>{candidate.source.expression}</strong><small>{candidate.category.replaceAll("_", " ")} · {candidate.level} · {candidate.source.start_ms} ms</small></div><b className="slm-score">{candidate.pedagogical_score}/100</b></header>
          <p>{candidate.recommendation_reason}</p>
          <div className="slm-candidate-controls">
            <button type="button" className="secondary-button" onClick={() => toggleExpanded(candidate.id)}>{isExpanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>} {isExpanded ? "Fechar prévia" : "Ver mini aula"}</button>
            <button type="button" className={isSelected ? "primary-button" : "secondary-button"} onClick={() => selectCandidate(candidate.id)}>{isSelected ? <Check size={14}/> : <Sparkles size={14}/>} {isSelected ? "Selecionada" : "Escolher esta mini aula"}</button>
          </div>
          {isExpanded && <div className="slm-lesson-preview">
            <div className="slm-source-quote"><small>VOCÊ ACABOU DE OUVIR</small><strong>{candidate.source.expression}</strong><span>{candidate.source.excerpt_pt}</span></div>
            <h5>{candidate.lesson.title}</h5><p>{candidate.lesson.explanation_pt}</p>
            <div className="slm-examples">{candidate.lesson.examples.map((example,index)=><div key={index}><small>{example.context}</small><strong>{example.en}</strong><span>{example.pt}</span></div>)}</div>
            <h5>Árvore de contextos</h5><div className="slm-context-tree">{candidate.lesson.context_tree.map(node=><div key={node.id}><strong>{node.title}</strong><p>{node.purpose}</p>{node.examples.map((example,index)=><small key={index}>{example.en} · {example.pt}</small>)}</div>)}</div>
            <details className="slm-score-details"><summary>Ver composição da pontuação</summary>{Object.entries(SMART_LEARNING_SCORE_WEIGHTS).map(([key,weight])=><div key={key}><span>{scoreLabels[key as keyof typeof scoreLabels]}</span><b>{candidate.score_breakdown[key as keyof typeof candidate.score_breakdown]}/{weight}</b><small>{candidate.score_evidence[key as keyof typeof candidate.score_evidence]}</small></div>)}</details>
            <div className="slm-narration"><h5><AudioLines size={15}/> Roteiro de narração · {candidate.lesson.narration.estimated_duration_seconds}s</h5><p>{candidate.lesson.narration.voice_direction}</p>{candidate.lesson.narration.segments.map(segment=><div key={segment.id}><span>{segment.language.toUpperCase()} · {segment.purpose}</span><p>{segment.text}</p></div>)}</div>
          </div>}
        </article>;
      })}</div>
      {selected && <div className="slm-audio-panel"><div><h4><Volume2 size={16}/> Áudio da mini aula selecionada</h4><p>{includedAudioCount} de {selected.lesson.narration.segments.length} segmentos com áudio gerado.</p></div><label className="slm-voice-select">Voz interna<select value={voiceId} onChange={event => setVoiceId(event.target.value)} disabled={!voiceReady}>{!voices.length && <option value="">Nenhuma voz pronta</option>}{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label><div className="slm-audio-actions"><button type="button" className="primary-button" disabled={!voiceReady || !voiceId || audioBusy} onClick={() => void generateInternalAudio(selected)}><AudioLines size={14}/>{audioBusy && audioCandidateId === selected.id ? "Gerando..." : "Gerar áudio interno"}</button><button type="button" className="secondary-button" onClick={() => void prepareElevenLabsScript(selected)}><Download size={14}/> Preparar roteiro ElevenLabs</button></div></div>}
    </>}
  </section>;
}

function parsedNotice(fileName: string) {
  return "JSON validado: " + fileName + ". Revise o ranking e escolha no máximo uma mini aula.";
}
