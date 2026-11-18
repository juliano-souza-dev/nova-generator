import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { desktopApi, isDesktopRuntime } from "../../services/desktop-api";
import type { GlobalSound } from "../../services/desktop-api";
import type { MotionGraphic } from "../motion-graphics/model";

type Options = {
  setMotion: (updater: MotionGraphic[] | ((current: MotionGraphic[]) => MotionGraphic[])) => void;
};

export function useGlobalSounds({ setMotion }: Options) {
  const [globalSounds, setGlobalSounds] = useState<GlobalSound[]>([]);
  const [soundUrls, setSoundUrls] = useState<Record<string, string>>({});
  const [newSoundName, setNewSoundName] = useState("");
  const [soundBusy, setSoundBusy] = useState(false);
  const [soundMessage, setSoundMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadGlobalSounds() {
      if (!isDesktopRuntime) return;
      try {
        const sounds = await desktopApi.listGlobalSounds();
        const entries = await Promise.all(sounds.map(async sound => {
          try { return [sound.id, convertFileSrc(await desktopApi.getGlobalSoundPath(sound.id))] as const; }
          catch { return [sound.id, ""] as const; }
        }));
        if (!cancelled) { setGlobalSounds(sounds); setSoundUrls(Object.fromEntries(entries)); }
      } catch (error) {
        if (!cancelled) setSoundMessage("Não foi possível carregar a biblioteca: " + String(error));
      }
    }
    void loadGlobalSounds();
    return () => { cancelled = true; };
  }, []);

  async function importGlobalSound() {
    if (!isDesktopRuntime || soundBusy) return;
    const selected = await open({ multiple: false, filters: [{ name: "Áudio", extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac"] }] });
    if (!selected || Array.isArray(selected)) return;
    const fallbackName = selected.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Novo efeito";
    const name = newSoundName.trim() || fallbackName;
    setSoundBusy(true);
    setSoundMessage("");
    try {
      const sound = await desktopApi.importGlobalSound(selected, name);
      const url = convertFileSrc(await desktopApi.getGlobalSoundPath(sound.id));
      setGlobalSounds(current => [...current, sound]);
      setSoundUrls(current => ({ ...current, [sound.id]: url }));
      setNewSoundName("");
      setSoundMessage("Efeito cadastrado na biblioteca global.");
    } catch (error) {
      setSoundMessage("Não foi possível importar: " + String(error));
    } finally {
      setSoundBusy(false);
    }
  }

  async function removeGlobalSound(soundId: string) {
    if (!window.confirm("Excluir este efeito da biblioteca global? Os textos que o utilizam ficarão sem áudio.")) return;
    try {
      await desktopApi.deleteGlobalSound(soundId);
      setGlobalSounds(current => current.filter(sound => sound.id !== soundId));
      setSoundUrls(current => {
        const next = { ...current };
        delete next[soundId];
        return next;
      });
      setMotion(current => current.map(item => item.soundId === soundId ? { ...item, soundId: "" } : item));
      setSoundMessage("Efeito removido da biblioteca.");
    } catch (error) {
      setSoundMessage("Não foi possível excluir: " + String(error));
    }
  }

  return {
    globalSounds, soundUrls, newSoundName, setNewSoundName,
    soundBusy, soundMessage, setSoundMessage, importGlobalSound, removeGlobalSound,
  };
}
