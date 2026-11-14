import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

export type ExternalTranslationPackage = {
  packageVersion: string;
  contractId: string;
  files: Record<string, string>;
};

/** Salva somente o TXT enumerado, sem ZIP ou arquivos auxiliares. */
export async function downloadExternalTranslationPackage(pkg: ExternalTranslationPackage): Promise<boolean> {
  const content = pkg.files["entrada-editorial.txt"];
  if (!content) throw new Error("O arquivo de entrada editorial não foi gerado.");

  const path = await save({
    title: "Salvar entrada para IA externa",
    defaultPath: "nova-editorial-entrada.txt",
    filters: [{ name: "Arquivo de texto", extensions: ["txt"] }]
  });
  if (!path) return false;

  await invoke("save_external_translation_package", {
    path,
    bytes: Array.from(new TextEncoder().encode(content))
  });
  return true;
}
