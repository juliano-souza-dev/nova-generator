import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MotionGraphic } from "./model";

type Options = {
  captions: MotionGraphic[];
  setCaptions: Dispatch<SetStateAction<MotionGraphic[]>>;
  selectedCaption: MotionGraphic | null;
  updateMotion: (id: string, patch: Partial<MotionGraphic>) => void;
};

/**
 * Caption translation in the legacy motion-graphics editor no longer calls
 * a hosted provider. Translation is handled by Nova's external editorial
 * package workflow, which keeps provider credentials and network calls out
 * of the desktop runtime.
 */
export function useCaptionTranslation({ captions, setCaptions, selectedCaption, updateMotion }: Options) {
  const [translationBusy, setTranslationBusy] = useState(false);
  const [singleCaptionTranslationBusy, setSingleCaptionTranslationBusy] = useState(false);
  const [translationProgress, setTranslationProgress] = useState({ done: 0, total: 0 });
  const [translationMessage, setTranslationMessage] = useState("");
  const [translationPhase, setTranslationPhase] = useState("Aguardando comando");
  const translationStopRef = useRef(false);

  // Keep the legacy hook contract stable while preventing accidental use of
  // the removed provider-backed implementation.
  void captions;
  void setCaptions;
  void selectedCaption;
  void updateMotion;

  async function translateCaptions() {
    if (translationBusy) return;
    setTranslationBusy(true);
    setTranslationProgress({ done: 0, total: 0 });
    setTranslationPhase("Tradução externa");
    setTranslationMessage(
      "A tradução automática integrada foi desativada. Use o fluxo de pacote editorial externo da transcrição para traduzir e importar as legendas."
    );
    setTranslationBusy(false);
  }

  async function translateSelectedCaption(targetLanguage: "English" | "Português brasileiro") {
    if (singleCaptionTranslationBusy) return;
    setSingleCaptionTranslationBusy(true);
    setTranslationPhase("Tradução externa");
    setTranslationMessage(
      "A tradução individual integrada foi desativada. Exporte a transcrição pelo pacote editorial externo e importe o JSON traduzido. Idioma solicitado: " +
        targetLanguage +
        "."
    );
    setSingleCaptionTranslationBusy(false);
  }

  function requestStopAfterCurrentBatch() {
    translationStopRef.current = true;
    setTranslationMessage("Não há lotes ativos para interromper. A tradução é realizada pelo fluxo editorial externo.");
  }

  return {
    translationBusy,
    singleCaptionTranslationBusy,
    translationProgress,
    translationMessage,
    setTranslationMessage,
    translationPhase,
    setTranslationPhase,
    translateCaptions,
    translateSelectedCaption,
    requestStopAfterCurrentBatch
  };
}
