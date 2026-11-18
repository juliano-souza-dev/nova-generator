import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { desktopApi, isDesktopRuntime } from "../../services/desktop-api";
import type { MotionGraphic } from "./model";

type Options = {
  captions: MotionGraphic[];
  setCaptions: Dispatch<SetStateAction<MotionGraphic[]>>;
  selectedCaption: MotionGraphic | null;
  updateMotion: (id: string, patch: Partial<MotionGraphic>) => void;
};

export function useCaptionTranslation({ captions, setCaptions, selectedCaption, updateMotion }: Options) {
  const [translationBusy, setTranslationBusy] = useState(false);
  const [singleCaptionTranslationBusy, setSingleCaptionTranslationBusy] = useState(false);
  const [translationProgress, setTranslationProgress] = useState({ done: 0, total: 0 });
  const [translationMessage, setTranslationMessage] = useState("");
  const [translationPhase, setTranslationPhase] = useState("Aguardando comando");
  const translationStopRef = useRef(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ stage: string; message: string }>("groq-translation-status", event => {
      if (!cancelled) {
        setTranslationPhase(event.payload.stage);
        setTranslationMessage(event.payload.message);
      }
    }).then(stop => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(error => {
      if (!cancelled) setTranslationMessage("Não foi possível acompanhar o status da Groq: " + String(error));
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  async function translateCaptions() {
    if (!isDesktopRuntime || translationBusy) return;
    const captionSequence = captions.slice().sort((a, b) => a.startMs - b.startMs);
    const pending = captionSequence.filter(item => !(item.captionTranslation || "").trim() && (item.captionEnglish || item.text || "").trim());
    if (!pending.length) {
      setTranslationMessage("Todas as legendas já possuem tradução.");
      return;
    }
    setTranslationBusy(true);
    setTranslationMessage("Verificando as configurações e a chave armazenada...");
    setTranslationPhase("Preparando");
    translationStopRef.current = false;
    try {
      const settings = await desktopApi.getGroqSettings();
      if (!settings.configured) throw new Error("Configure sua chave Groq em Configurações antes de traduzir.");
      setTranslationPhase("Preparando lotes");
      setTranslationMessage("Chave encontrada. Organizando as legendas em lotes para envio.");
      const chunks: Array<Array<{ id: string; text: string; contextBefore?: string; contextAfter?: string; words?: string[] }>> = [];
      let chunk: Array<{ id: string; text: string; contextBefore?: string; contextAfter?: string; words?: string[] }> = [];
      let chars = 0;
      for (const item of pending) {
        const cueIndex = captionSequence.findIndex(caption => caption.id === item.id);
        const cueText = (item.captionEnglish || item.text).trim();
        const sourceWords = item.captionWords?.map(word => word.text) || [];
        const cueBytes = new TextEncoder().encode(cueText + " " + sourceWords.join(" ")).length;
        if (cueBytes > settings.maxChunkChars || cueBytes > 18000) {
          throw new Error("A legenda " + item.id + " excede o limite configurado para um lote. Reduza o texto antes de traduzir.");
        }
        const cue = {
          id: item.id,
          text: cueText,
          contextBefore: cueIndex > 0 ? (captionSequence[cueIndex - 1].captionEnglish || captionSequence[cueIndex - 1].text).slice(-240) : undefined,
          contextAfter: cueIndex >= 0 && cueIndex < captionSequence.length - 1 ? (captionSequence[cueIndex + 1].captionEnglish || captionSequence[cueIndex + 1].text).slice(0, 240) : undefined,
          words: /portugu/i.test(settings.targetLanguage) && sourceWords.length ? sourceWords : undefined,
        };
        if (chunk.length && (chunk.length >= settings.maxCuesPerChunk || chars + cueBytes > settings.maxChunkChars)) {
          chunks.push(chunk);
          chunk = [];
          chars = 0;
        }
        chunk.push(cue);
        chars += cueBytes;
      }
      if (chunk.length) chunks.push(chunk);
      setTranslationProgress({ done: 0, total: pending.length });
      let completed = 0;
      setTranslationPhase("Pronto para enviar");
      setTranslationMessage(chunks.length + " lote(s) preparado(s). Iniciando comunicação com a Groq.");
      for (let index = 0; index < chunks.length; index++) {
        if (translationStopRef.current) break;
        setTranslationPhase("Enviando para a Groq");
        setTranslationMessage("Lote " + (index + 1) + " de " + chunks.length + ": solicitação enviada. Aguardando a resposta da IA...");
        const result = await desktopApi.translateGroqChunk(settings.targetLanguage, chunks[index]);
        setTranslationPhase("Aplicando traduções");
        setTranslationMessage("Resposta recebida para o lote " + (index + 1) + ". Aplicando traduções ao projeto...");
        const byId = new Map(result.map(item => [item.id, item]));
        setCaptions(current => current.map(item => {
          const translated = byId.get(item.id);
          if (!translated) return item;
          const words = item.captionWords?.map(word => ({ ...word })) || [];
          const isPortugueseTarget = /portugu/i.test(settings.targetLanguage);
          const groups = isPortugueseTarget ? (translated.wordGroups || []) : [];
          const assigned = new Set<number>();
          if (!isPortugueseTarget) words.forEach(word => { delete word.pt; delete word.ptGroup; delete word.ptGroupRole; delete word.translation; });
          const validGroups = groups.length > 0 && groups.every(group => {
            if (!Number.isInteger(group.startWord) || !Number.isInteger(group.endWord) || group.startWord < 0 || group.endWord < group.startWord || group.endWord >= words.length || !group.pt?.trim()) return false;
            for (let index = group.startWord; index <= group.endWord; index++) { if (assigned.has(index)) return false; assigned.add(index); }
            return true;
          }) && assigned.size === words.length;
          if (validGroups) groups.forEach((group, groupIndex) => {
            const groupId = `${item.id}:pt:${groupIndex}`;
            for (let index = group.startWord; index <= group.endWord; index++) words[index] = {
              ...words[index], ptGroup: groupId, ptGroupRole: index === group.startWord ? "lead" : "member",
              pt: index === group.startWord ? group.pt.trim() : "", translation: index === group.startWord ? group.pt.trim() : "",
            };
          });
          return { ...item, captionTranslation: translated.translation, captionMode: words.length ? "karaoke" : "bilingual", ...(words.length ? { captionWords: words } : {}) };
        }));
        completed += chunks[index].length;
        setTranslationProgress({ done: completed, total: pending.length });
        setTranslationMessage("Lote " + (index + 1) + " de " + chunks.length + " concluído. O progresso foi salvo no projeto.");
        if (index < chunks.length - 1 && settings.delayMs > 0) {
          setTranslationPhase("Pausa entre lotes");
          setTranslationMessage("Lote " + (index + 1) + " concluído. Aguardando " + (settings.delayMs / 1000).toFixed(1) + "s antes do próximo envio.");
          await new Promise(resolve => window.setTimeout(resolve, settings.delayMs));
        }
      }
      if (completed === pending.length) {
        setTranslationPhase("Concluído");
        setTranslationMessage("Tradução concluída: " + completed + " legenda(s). Revise o resultado no painel de propriedades.");
      } else {
        setTranslationPhase("Interrompido");
        setTranslationMessage("Processamento interrompido após " + completed + " legenda(s). As traduções concluídas foram preservadas. Execute novamente para continuar.");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      let category = "Falha durante a tradução";
      if (/Falha de rede|conexão|timed out|timeout|dns|connect error/i.test(detail)) category = "Falha de conexão com a Groq";
      else if (/HTTP 401|HTTP 403|chave|unauthorized|forbidden/i.test(detail)) category = "Problema de autenticação da API";
      else if (/HTTP 429|rate_limit|quota|limite/i.test(detail)) category = "Limite de uso da API atingido";
      else if (/HTTP 5\d\d|server error|temporariamente indisponível/i.test(detail)) category = "Instabilidade no serviço da Groq";
      else if (/JSON inválido|resposta inesperada|resposta vazia|traduz[iu] .* de/i.test(detail)) category = "Resposta inválida ou incompleta da IA";
      setTranslationPhase("Falha identificada");
      setTranslationMessage(category + ". " + detail + " As legendas já concluídas foram preservadas.");
    } finally {
      setTranslationBusy(false);
    }
  }

  async function translateSelectedCaption(targetLanguage: "English" | "Português brasileiro") {
    if (!selectedCaption?.isCaption || singleCaptionTranslationBusy || !isDesktopRuntime) return;
    const sourceText = (selectedCaption.captionEnglish || selectedCaption.text || "").trim();
    if (!sourceText) return;
    setSingleCaptionTranslationBusy(true);
    setTranslationMessage("");
    try {
      const settings = await desktopApi.getGroqSettings();
      if (!settings.configured) throw new Error("Configure sua chave Groq nas configurações antes de traduzir.");
      const result = await desktopApi.translateGroqChunk(targetLanguage, [{
        id: selectedCaption.id,
        text: sourceText,
        words: /portugu/i.test(targetLanguage) ? selectedCaption.captionWords?.map(word => word.text) : undefined,
      }]);
      const translatedResult = result.find(item => item.id === selectedCaption.id);
      const translated = translatedResult?.translation;
      if (!translated) throw new Error("A tradução não foi retornada para esta legenda.");
      const words = selectedCaption.captionWords?.map(word => ({ ...word })) || [];
      const isPortugueseTarget = /portugu/i.test(targetLanguage);
      const groups = isPortugueseTarget ? (translatedResult?.wordGroups || []) : [];
      const assigned = new Set<number>();
      if (!isPortugueseTarget) words.forEach(word => { delete word.pt; delete word.ptGroup; delete word.ptGroupRole; delete word.translation; });
      const validGroups = groups.length > 0 && groups.every(group => {
        if (!Number.isInteger(group.startWord) || !Number.isInteger(group.endWord) || group.startWord < 0 || group.endWord < group.startWord || group.endWord >= words.length || !group.pt?.trim()) return false;
        for (let index = group.startWord; index <= group.endWord; index++) { if (assigned.has(index)) return false; assigned.add(index); }
        return true;
      }) && assigned.size === words.length;
      if (validGroups) groups.forEach((group, groupIndex) => {
        const groupId = `${selectedCaption.id}:pt:${groupIndex}`;
        for (let index = group.startWord; index <= group.endWord; index++) words[index] = {
          ...words[index], ptGroup: groupId, ptGroupRole: index === group.startWord ? "lead" : "member",
          pt: index === group.startWord ? group.pt.trim() : "", translation: index === group.startWord ? group.pt.trim() : "",
        };
      });
      updateMotion(selectedCaption.id, {
        ...(words.length ? { captionWords: words } : {}),
        captionTranslation: translated,
        captionTranslationLanguage: targetLanguage === "English" ? "en" : "pt-BR",
        captionMode: selectedCaption.captionWords?.length ? "karaoke" : "bilingual",
      });
      setTranslationPhase("Concluído");
      setTranslationMessage("Legenda traduzida para " + targetLanguage + ".");
    } catch (error) {
      setTranslationPhase("Falha identificada");
      setTranslationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSingleCaptionTranslationBusy(false);
    }
  }

  function requestStopAfterCurrentBatch() {
    translationStopRef.current = true;
    setTranslationMessage("Aguardando o lote atual terminar para interromper com segurança...");
  }

  return {
    translationBusy, singleCaptionTranslationBusy, translationProgress,
    translationMessage, setTranslationMessage, translationPhase, setTranslationPhase, translateCaptions,
    translateSelectedCaption, requestStopAfterCurrentBatch
  };
}
