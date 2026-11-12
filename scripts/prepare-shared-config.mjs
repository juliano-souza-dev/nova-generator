import { copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "shared.config.example.json");
const target = path.join(root, "shared.config.json");

try {
  await access(target, constants.F_OK);
  console.log("shared.config.json já existe. Nenhuma alteração foi feita.");
  process.exit(0);
} catch {
  // Create only when missing. Never overwrite a configuration provisioned by Shared.
}

await copyFile(source, target, constants.COPYFILE_EXCL);
console.log("shared.config.json local criado a partir do exemplo.");
console.log("Registre este diretório no Shared Runtime Manager e sincronize a aplicação.");
console.log("O arquivo é ignorado pelo Git e não será enviado ao repositório.");
