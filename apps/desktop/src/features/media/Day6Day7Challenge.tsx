import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { Check, FileText, LoaderCircle, Upload } from "lucide-react";
import type { ListeningQuestion, SpeakingPrompt } from "./learning-journey-contract";
import "./Day6Day7Challenge.css";

type Cue = { id: string; text: string; startMs: number; endMs: number; words?: { text: string; startMs: number; endMs: number }[] };
type CandidateListening = ListeningQuestion & { sourceText: string; score: number; score_breakdown: Record<string, number>; difficulty: Difficulty; status?: Status; include_in_hub?: boolean };
type CandidateSpeaking = SpeakingPrompt & { scenarioPt: string; responseTask: string; responseGuidancePt: string; expectedElements: string[]; score: number; score_breakdown: Record<string, number>; difficulty: Difficulty; status?: Status; include_in_hub?: boolean };
type Difficulty = "beginner" | "elementary" | "intermediate" | "upper-intermediate";
type Status = "draft" | "approved" | "rejected";
type Props = {
  day: 6 | 7; projectId: string; assetId: string; sourceSignature: string; cues: Cue[];
  listening: ListeningQuestion[]; speaking: SpeakingPrompt[]; successCriteria: string[];
  onChange: (value: { listening: ListeningQuestion[]; speaking: SpeakingPrompt[]; successCriteria: string[] }) => void;
  onBack: () => void; onSave: () => void; saving: boolean;
};
const weights = { source_fidelity: 20, integration_value: 20, communicative_value: 15, clarity: 15, level_fit: 10, response_quality: 10, variety: 10 };
const focuses = ["response", "fluency", "pronunciation", "interaction", "spontaneous-speaking"] as const;
const focusLabels: Record<string,string> = { response: "Resposta", fluency: "Fluência", pronunciation: "Pronúncia", interaction: "Interação", "spontaneous-speaking": "Produção espontânea" };
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const isObject = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim().replace(/\s+/g, " ");
const levels = ["beginner", "elementary", "intermediate", "upper-intermediate"];
const OUTPUT = "nova-generator-journey-challenge-output/1.0";
const INPUT = "nova-generator-journey-challenge-input/1.0";
const dayMeta = {
  6: { title: "Listening & Speaking Challenge", subtitle: "Escutar, interpretar e responder em inglês", min: 4, max: 6 },
  7: { title: "Final Challenge", subtitle: "Avaliação integrada de compreensão e produção oral", min: 3, max: 5 }
} as const;

export default function Day6Day7Challenge({ day, projectId, assetId, sourceSignature, cues, listening, speaking, successCriteria, onChange, onBack, onSave, saving }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy,setBusy]=useState(false), [error,setError]=useState(""), [notice,setNotice]=useState(""), [fileName,setFileName]=useState("");
  const meta=dayMeta[day];
  const sourceCues=useMemo(()=>cues.map((cue,index)=>({cue_order:index+1,cue_id:cue.id,start_ms:Math.round(cue.startMs),end_ms:Math.round(cue.endMs),text_en:cue.text,words:(cue.words??[]).map(word=>({text:word.text,start_ms:Math.round(word.startMs),end_ms:Math.round(word.endMs)}))})).filter(cue=>cue.text_en.trim()&&cue.end_ms>cue.start_ms),[cues]);
  const input=useMemo(()=>({contract:INPUT,project_id:projectId,asset_id:assetId,source_signature:sourceSignature,language:{source:"en",support:"pt-BR"},day,title:meta.title,source_cues:sourceCues,learning_goal:day===6?"Integrar listening e resposta oral em situações comunicativas baseadas na cena.":"Verificar de forma integrada a compreensão auditiva e a produção oral, sem ensinar conteúdo novo durante a avaliação."}),[projectId,assetId,sourceSignature,day,meta.title,sourceCues]);
  async function getHash(){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(input)));return Array.from(new Uint8Array(digest)).map(v=>v.toString(16).padStart(2,"0")).join("");}
  async function exportInstructions(){
    if(busy||sourceCues.length<4)return;setBusy(true);setError("");setNotice("");
    try{
      const hash=await getHash();
      const template={contract:OUTPUT,source_hash:hash,day,listening:[{id:"listen-01",type:"detail",prompt:"What is the speaker communicating?",audioCueOrders:[1],sourceText:"exact excerpt from the selected cue",options:[{id:"a",text:"plausible interpretation"},{id:"b",text:"correct interpretation"},{id:"c",text:"plausible interpretation"}],answerId:"b",explanationPt:"brief explanation",feedbackCorrectPt:"Correct.",feedbackIncorrectPt:"Listen again and notice the key information.",score:90,score_breakdown:{source_fidelity:19,integration_value:18,communicative_value:14,clarity:14,level_fit:9,response_quality:8,variety:8},pedagogical_rationale:"Why this listening task supports the day's goal.",difficulty:"beginner"}],speaking:[{id:"speak-01",cueOrders:[1],sourceText:"exact excerpt from the selected cue",translationPt:"natural Brazilian Portuguese meaning",focus:"response",scenarioPt:"A short, clear situation grounded in the scene.",responseTask:"Answer the situation aloud in your own words.",responseGuidancePt:"Give a short answer using the information you heard.",expectedElements:["Mention the key information from the audio.","Give a relevant response."],score:90,score_breakdown:{source_fidelity:19,integration_value:18,communicative_value:14,clarity:14,level_fit:9,response_quality:8,variety:8},pedagogical_rationale:"Why this speaking task is a useful response to the listening task.",difficulty:"beginner"}],successCriteria:day===7?["Compreender a informação principal dos trechos.","Identificar detalhes relevantes sem depender das legendas.","Responder oralmente de forma pertinente à situação.","Comunicar a resposta com clareza e continuidade."]:[]};
      const lines=[
        "NOVA GENERATOR | JORNADA DE APRENDIZAGEM", "DAY "+String(day).padStart(2,"0")+" · "+meta.title.toUpperCase(),
        "EXTERNAL AI GENERATION PACKAGE | INPUT 1.0","INPUT_CONTRACT: "+INPUT,"REQUIRED_OUTPUT_CONTRACT: "+OUTPUT,
        "SOURCE_HASH: "+hash,"PROJECT_ID: "+projectId,"ASSET_ID: "+assetId,"SOURCE_SIGNATURE: "+sourceSignature,"",
        "1. OBJETIVO PEDAGÓGICO",
        day===6?"Crie um desafio integrado. Em cada ciclo, o aluno primeiro ouve um trecho original e demonstra que compreendeu a mensagem. Em seguida, responde oralmente a uma situação comunicativa relacionada ao que ouviu. O listening deve preparar a resposta, e o speaking deve exigir uso ativo da informação, não repetição mecânica da fala.":"Crie uma avaliação final integrada de listening e speaking. O aluno escuta trechos originais, interpreta informações e responde oralmente de forma relevante. Avalie compreensão e comunicação funcional, sem transformar a avaliação em prova de gramática ou imitação de sotaque.",
        "2. QUANTIDADE E RELAÇÃO ENTRE AS ETAPAS",
        "Gere entre "+meta.min+" e "+meta.max+" itens em listening e a mesma quantidade em speaking. Cada item deve usar exatamente uma cue existente em audioCueOrders/cueOrders. Organize os itens na mesma ordem temática: cada atividade oral deve funcionar como resposta comunicativa a uma situação ou informação explorada no listening. Evite duplicar a mesma pergunta ou resposta.",
        "3. LISTENING",
        "Use somente os tipos identify, detail ou gap. identify/detail: 3 ou 4 alternativas, answerId válido e uma única resposta correta. gap: sentence com exatamente uma lacuna _____ e acceptedAnswers que restaurem a frase original. sourceText deve ser um excerto literal contínuo da cue. Toda pergunta precisa exigir ouvir o áudio, não pode ser respondida apenas pela leitura.",
        "4. SPEAKING",
        "Cada item speaking deve conter sourceText literal da cue, scenarioPt, responseTask, responseGuidancePt, expectedElements (2 a 4 critérios observáveis), translationPt opcional e focus exatamente um destes valores: response, fluency, pronunciation, interaction, spontaneous-speaking. O aluno deve formular uma resposta própria em inglês, não apenas repetir a fala original. A situação precisa ser sustentada pelo contexto disponível; não invente personagens, intenções ou fatos não presentes na cena. Não escreva uma resposta-modelo completa que o aluno apenas copie.",
        "5. FIDELIDADE E LIMITES",
        "O pacote contém transcrição e tempos, não áudio. Não afirme que ouviu a gravação nem invente detalhes acústicos, sotaques ou pronúncia. Não crie falas inexistentes. Use cue orders existentes e mantenha sourceText como trecho literal da cue. Explicações e orientações em português brasileiro. Dificuldade beginner como padrão, elevando somente quando necessário.",
        "6. PONTUAÇÃO",
        "Cada item listening e speaking deve ter score numérico de 70 a 100 e score_breakdown com exatamente estas chaves e limites, sem extras, cuja soma seja igual ao score: "+JSON.stringify(weights)+". difficulty deve ser exatamente beginner, elementary, intermediate ou upper-intermediate. Ordene listening e speaking separadamente por score decrescente. IDs únicos dentro de cada lista.",
        day===7?"7. CRITÉRIOS DA AVALIAÇÃO FINAL":"7. CRITÉRIOS",
        day===7?"Retorne successCriteria com exatamente quatro critérios claros e observáveis, cobrindo compreensão global, detalhes, pertinência da resposta e clareza/continuidade da fala. Não invente nota de corte nem pesos globais.":"Retorne successCriteria como array vazio.",
        "8. SAÍDA","Retorne SOMENTE JSON válido, sem Markdown, comentários ou texto externo. Não inclua outros dias.",JSON.stringify(template,null,2),"","9. MATERIAL DE ORIGEM",JSON.stringify(input,null,2)
      ];
      const path=await saveFile({title:"Salvar instruções do Dia "+day,defaultPath:"day-"+day+"-"+(day===6?"listening-speaking":"final-challenge")+"-"+assetId+".txt",filters:[{name:"Instruções para IA externa",extensions:["txt"]}]});
      if(!path)return;
      await invoke("save_external_translation_package",{path,bytes:Array.from(new TextEncoder().encode("\uFEFF"+lines.join("\r\n")))});
      setNotice("Instruções do Dia "+day+" exportadas.");
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  function validateListening(raw:any,valid:Set<number>){
    const errors:string[]=[];
    if(!clean(raw?.id)||!clean(raw?.prompt)||!clean(raw?.sourceText))errors.push("ID, pergunta ou trecho original ausente");
    if(!["identify","detail","gap"].includes(raw?.type))errors.push("type inválido");
    if(!Array.isArray(raw?.audioCueOrders)||raw.audioCueOrders.length!==1||!valid.has(Number(raw.audioCueOrders[0])))errors.push("audioCueOrders deve indicar uma cue válida");
    const cue=sourceCues.find(c=>c.cue_order===Number(raw?.audioCueOrders?.[0]));
    if(!cue||!normalize(cue.text_en).includes(normalize(clean(raw?.sourceText))))errors.push("sourceText não corresponde à cue");
    if(!clean(raw?.explanationPt)||!clean(raw?.feedbackCorrectPt)||!clean(raw?.feedbackIncorrectPt))errors.push("explicação ou feedback ausente");
    if(raw?.type==="identify"||raw?.type==="detail"){
      const answer=Array.isArray(raw.options)?raw.options.find((o:any)=>o.id===raw.answerId):null;
      if(!Array.isArray(raw.options)||raw.options.length<3||raw.options.length>4||!answer||new Set(raw.options.map((o:any)=>normalize(clean(o.text)))).size!==raw.options.length)errors.push("alternativas inválidas");
    }else if(raw?.type==="gap"){
      if((clean(raw.sentence).match(/_____/g)||[]).length!==1||!Array.isArray(raw.acceptedAnswers)||!raw.acceptedAnswers.length||!raw.acceptedAnswers.some((a:string)=>normalize(clean(raw.sentence).replace("_____",clean(a)))===normalize(clean(raw.sourceText))))errors.push("lacuna ou resposta não restaura o trecho original");
    }
    return errors.concat(scoreErrors(raw));
  }
  function scoreErrors(raw:any){
    const keys=Object.keys(weights),b=raw?.score_breakdown,s=raw?.score;
    if(typeof s!=="number"||s<70||s>100||!isObject(b)||Object.keys(b).length!==keys.length||keys.some(k=>typeof b[k]!=="number"||b[k]<0||b[k]>(weights as any)[k])||keys.reduce((sum,k)=>sum+(b[k]??0),0)!==s)return ["score_breakdown inválido: use as sete chaves e respeite os pesos"];
    if(!levels.includes(raw?.difficulty))return ["difficulty inválido"];
    return [];
  }
  function validateSpeaking(raw:any,valid:Set<number>){
    const errors:string[]=[];
    if(!clean(raw?.id)||!clean(raw?.sourceText)||!clean(raw?.scenarioPt)||!clean(raw?.responseTask)||!clean(raw?.responseGuidancePt))errors.push("campos essenciais da prática oral ausentes");
    if(!focuses.includes(raw?.focus))errors.push("focus inválido");
    if(!Array.isArray(raw?.cueOrders)||raw.cueOrders.length!==1||!valid.has(Number(raw.cueOrders[0])))errors.push("cueOrders deve indicar uma cue válida");
    const cue=sourceCues.find(c=>c.cue_order===Number(raw?.cueOrders?.[0]));
    if(!cue||!normalize(cue.text_en).includes(normalize(clean(raw?.sourceText))))errors.push("sourceText não corresponde à cue");
    if(!Array.isArray(raw?.expectedElements)||raw.expectedElements.length<2||raw.expectedElements.length>4||raw.expectedElements.some((v:any)=>!clean(v)))errors.push("expectedElements deve ter de 2 a 4 critérios");
    return errors.concat(scoreErrors(raw));
  }
  async function importJson(file?:File){
    if(!file||busy)return;setBusy(true);setError("");setNotice("");setFileName(file.name);
    try{
      if(file.size>8*1024*1024)throw new Error("O JSON excede 8 MB.");
      const data=JSON.parse(await file.text());
      if(!isObject(data)||data.contract!==OUTPUT||data.day!==day||!Array.isArray(data.listening)||!Array.isArray(data.speaking)||data.listening.length<meta.min||data.listening.length>meta.max||data.speaking.length<meta.min||data.speaking.length>meta.max)throw new Error("Contrato, dia ou quantidade de atividades inválidos.");
      if(data.source_hash!==await getHash())throw new Error("O JSON foi gerado para outra mídia ou versão da transcrição. Exporte as instruções novamente.");
      const valid=new Set(sourceCues.map(c=>c.cue_order));
      for(const list of [data.listening,data.speaking])for(let i=1;i<list.length;i++)if(Number(list[i-1]?.score)<Number(list[i]?.score))throw new Error("As atividades precisam estar ordenadas por score decrescente.");
      for(const [name,list,validate] of [["listening",data.listening,validateListening],["speaking",data.speaking,validateSpeaking]] as const){
        const ids=list.map((item:any)=>clean(item?.id));if(ids.some((id:string)=>!id)||new Set(ids).size!==ids.length)throw new Error("IDs ausentes ou duplicados em "+name+".");
        const invalid=list.map((item:any)=>({item,errors:validate(item,valid)})).filter((v:any)=>v.errors.length);
        if(invalid.length)throw new Error("JSON não aprovado em "+name+":\n"+invalid.slice(0,6).map((v:any)=>v.item?.id+": "+v.errors.join(", ")).join("\n"));
      }
      const criteria=day===7?data.successCriteria:[];
      if(day===7&&(!Array.isArray(criteria)||criteria.length!==4||criteria.some((v:any)=>!clean(v))))throw new Error("O Dia 7 exige exatamente quatro critérios de avaliação.");
      if(day===6&&(!Array.isArray(data.successCriteria)||data.successCriteria.length!==0))throw new Error("No Dia 6, successCriteria deve ser um array vazio.");
      const importedListening = data.listening.map((v:any) => ({ ...v, status: "approved" }) as unknown as ListeningQuestion);
      const importedSpeaking = data.speaking.map((v:any) => ({ ...v, status: "approved" }) as unknown as SpeakingPrompt);
      onChange({ listening: importedListening, speaking: importedSpeaking, successCriteria: criteria });
      setNotice("Conteúdo importado e aprovado. Você pode rejeitar individualmente o que não deseja enviar ao iHub.");
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);if(fileRef.current)fileRef.current.value="";}
  }
  function updateListening(id:string,patch:Partial<CandidateListening>){onChange({...current,listening:current.listening.map(item=>item.id===id?{...item,...patch}:item)});}
  function updateSpeaking(id:string,patch:Partial<CandidateSpeaking>){onChange({...current,speaking:current.speaking.map(item=>item.id===id?{...item,...patch}:item)});}
  const current={listening,speaking,successCriteria};
  const approvedListening=listening.filter(v=>(v as CandidateListening).status==="approved"&&(v as CandidateListening).include_in_hub!==false);
  const approvedSpeaking=speaking.filter(v=>(v as CandidateSpeaking).status==="approved"&&(v as CandidateSpeaking).include_in_hub!==false);
  const renderListening=(item:ListeningQuestion,index:number)=><article className={"d67-card"+((item as CandidateListening).status==="approved"?" is-approved":(item as CandidateListening).status==="rejected"?" is-rejected":"")} key={item.id}>
    <div className="d67-card-head"><span>LISTENING · {String(index+1).padStart(2,"0")} · {item.type}</span><strong>{(item as CandidateListening).score??"—"}/100</strong></div>
    <p className="d67-question">{item.prompt}</p><div className="d67-source"><small>FALA ORIGINAL</small><p>{(item as CandidateListening).sourceText}</p></div>
    {("options" in item)&&<div className="d67-options">{item.options.map(o=><p key={o.id}>{o.text}{o.id===item.answerId?" ✓":""}</p>)}</div>}
    {("sentence" in item)&&<div className="d67-options"><p>{item.sentence}</p><small>Resposta: {item.acceptedAnswers.join(" / ")}</small></div>}
    <p className="d67-feedback">{item.explanationPt}</p>
    <div className="d67-review"><button type="button" onClick={()=>updateListening(item.id,{status:"approved",include_in_hub:true})} disabled={(item as CandidateListening).status==="approved"}>Aprovar</button><button type="button" onClick={()=>updateListening(item.id,{status:"rejected",include_in_hub:false})} disabled={(item as CandidateListening).status==="rejected"}>Rejeitar</button></div>
  </article>;
  const renderSpeaking=(item:SpeakingPrompt,index:number)=><article className={"d67-card"+((item as CandidateSpeaking).status==="approved"?" is-approved":(item as CandidateSpeaking).status==="rejected"?" is-rejected":"")} key={item.id}>
    <div className="d67-card-head"><span>SPEAKING · {String(index+1).padStart(2,"0")} · {focusLabels[item.focus]??item.focus}</span><strong>{(item as CandidateSpeaking).score??"—"}/100</strong></div>
    <div className="d67-source"><small>SITUAÇÃO</small><p>{(item as CandidateSpeaking).scenarioPt}</p></div>
    <strong className="d67-response-task">{(item as CandidateSpeaking).responseTask}</strong><p className="d67-feedback">{(item as CandidateSpeaking).responseGuidancePt}</p>
    <div className="d67-options"><small>CRITÉRIOS DA RESPOSTA</small>{((item as CandidateSpeaking).expectedElements??[]).map((v,i)=><p key={i}>{v}</p>)}</div>
    <div className="d67-review"><button type="button" onClick={()=>updateSpeaking(item.id,{status:"approved",include_in_hub:true})} disabled={(item as CandidateSpeaking).status==="approved"}>Aprovar</button><button type="button" onClick={()=>updateSpeaking(item.id,{status:"rejected",include_in_hub:false})} disabled={(item as CandidateSpeaking).status==="rejected"}>Rejeitar</button></div>
  </article>;
  return <section className="d67-workspace">
    <header className="d67-header"><div><span>JORNADA DE APRENDIZAGEM · DIA {day}</span><h3>{meta.title}</h3><p>{meta.subtitle}</p></div><button type="button" onClick={onBack}>← Voltar aos dias</button></header>
    <div className="d67-stats"><div><strong>{sourceCues.length}</strong><span>trechos disponíveis</span></div><div><strong>{listening.length}</strong><span>atividades listening</span></div><div><strong>{speaking.length}</strong><span>atividades speaking</span></div><div><strong>{approvedListening.length+approvedSpeaking.length}</strong><span>aprovadas para o iHub</span></div></div>
    <div className="d67-actions"><button type="button" onClick={()=>void exportInstructions()} disabled={busy||sourceCues.length<4}><FileText size={15}/> Exportar instruções para IA</button><button type="button" onClick={()=>fileRef.current?.click()} disabled={busy}><Upload size={15}/> Importar JSON</button><input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={e=>void importJson(e.target.files?.[0])}/><button type="button" onClick={onSave} disabled={saving||busy}><Check size={15}/>{saving?"Salvando...":"Salvar"}</button>{busy&&<span><LoaderCircle className="d67-spin" size={15}/> Processando...</span>}</div>
    {fileName&&<small className="d67-file">{fileName}</small>}{error&&<pre className="d67-error">{error}</pre>}{notice&&<p className="d67-notice">{notice}</p>}
    {day===7&&successCriteria.length>0&&<div className="d67-criteria"><strong>Critérios da avaliação final</strong>{successCriteria.map((v,i)=><p key={i}>{v}</p>)}</div>}
    <div className="d67-section"><h4>Listening</h4><div className="d67-grid">{listening.length?listening.map(renderListening):<p className="d67-empty">As atividades de listening aparecerão aqui.</p>}</div></div>
    <div className="d67-section"><h4>Speaking</h4><div className="d67-grid">{speaking.length?speaking.map(renderSpeaking):<p className="d67-empty">As atividades de speaking aparecerão aqui.</p>}</div></div>
    <footer className="d67-footer"><span>{approvedListening.length+approvedSpeaking.length} de {listening.length+speaking.length} atividades aprovadas</span><button type="button" onClick={onBack}>Voltar aos dias</button><button type="button" onClick={onSave} disabled={saving}>Salvar preparação</button></footer>
  </section>;
}
