import { useState } from "react";
import { desktopApi, isDesktopRuntime } from "../../services/desktop-api";

export function useGroqSettings() {
  const [groqSettingsOpen, setGroqSettingsOpen] = useState(false);
  const [groqModel, setGroqModel] = useState("llama-3.3-70b-versatile");
  const [groqMaxChars, setGroqMaxChars] = useState(7000);
  const [groqMaxCues, setGroqMaxCues] = useState(25);
  const [groqDelay, setGroqDelay] = useState(1800);
  const [groqLanguage, setGroqLanguage] = useState("Português brasileiro");
  const [groqSettingsBusy, setGroqSettingsBusy] = useState(false);
  const [groqSettingsMessage, setGroqSettingsMessage] = useState("");

  async function openGroqSettings() {
    setGroqSettingsOpen(true);
    setGroqSettingsMessage("");
    if (!isDesktopRuntime) return;
    try {
      const settings = await desktopApi.getGroqSettings();
      setGroqModel(settings.model);
      setGroqMaxChars(settings.maxChunkChars);
      setGroqMaxCues(settings.maxCuesPerChunk);
      setGroqDelay(settings.delayMs);
      setGroqLanguage(settings.targetLanguage);
    } catch (error) {
      setGroqSettingsMessage("Não foi possível carregar as configurações: " + String(error));
    }
  }

  async function saveAndTestGroq() {
    setGroqSettingsBusy(true);
    setGroqSettingsMessage("");
    try {
      await desktopApi.saveGroqSettings({
        maxChunkChars: groqMaxChars,
        maxCuesPerChunk: groqMaxCues,
        delayMs: groqDelay,
        targetLanguage: groqLanguage
      });
      setGroqSettingsMessage("Preferências salvas. Testando a conexão com a credencial do Shared Runtime...");
      const result = await desktopApi.testGroqConnection();
      setGroqSettingsMessage("Preferências salvas. " + result);
    } catch (error) {
      setGroqSettingsMessage("Falha ao salvar ou testar a Groq: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setGroqSettingsBusy(false);
    }
  }

  return {
    groqSettingsOpen, setGroqSettingsOpen,
    groqModel,
    groqMaxChars, setGroqMaxChars,
    groqMaxCues, setGroqMaxCues,
    groqDelay, setGroqDelay,
    groqLanguage, setGroqLanguage,
    groqSettingsBusy, groqSettingsMessage,
    openGroqSettings, saveAndTestGroq
  };
}
