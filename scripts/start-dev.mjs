import { spawn } from "node:child_process";
import { appendFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const errorLog = path.join(root, "error.log");
const maxCapturedOutput = 2 * 1024 * 1024;

async function recordFailure(command, label, exitCode, output, error) {
  const timestamp = new Date().toISOString();
  const entry = [
    "",
    "=".repeat(90),
    "DATA: " + timestamp,
    "ETAPA: " + label,
    "COMANDO: " + command,
    "CÓDIGO DE SAÍDA: " + (exitCode ?? "não iniciado"),
    "ERRO: " + (error?.stack ?? error?.message ?? String(error)),
    "",
    "SAÍDA DO PROCESSO:",
    output || "(sem saída capturada)",
    "=".repeat(90),
    ""
  ].join("\n");

  try {
    await appendFile(errorLog, entry, "utf8");
    console.error("\nO erro foi registrado em: " + errorLog);
  } catch (logError) {
    console.error("Não foi possível gravar error.log:", logError);
  }
}

async function run(command, args, label) {
  const printable = [command, ...args].join(" ");
  console.log("\n" + "=".repeat(68));
  console.log(" " + label);
  console.log(" " + printable);
  console.log("=".repeat(68) + "\n");

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === "win32",
      windowsHide: false,
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1" }
    });

    let output = "";
    let settled = false;
    let stderrLogStarted = false;
    let stderrLogQueue = Promise.resolve();
    const capture = chunk => {
      const value = chunk.toString();
      process.stdout.write(value);
      output = (output + value).slice(-maxCapturedOutput);
    };
    const captureError = chunk => {
      const value = chunk.toString();
      process.stderr.write(value);
      output = (output + value).slice(-maxCapturedOutput);

      // Persist stderr as it happens, even if the process keeps running.
      const header = stderrLogStarted ? "" : [
        "",
        "=".repeat(90),
        "DATA: " + new Date().toISOString(),
        "ETAPA: " + label,
        "COMANDO: " + printable,
        "SAÍDA DE ERRO (stderr):",
        ""
      ].join("\n") + "\n";
      stderrLogStarted = true;
      stderrLogQueue = stderrLogQueue
        .then(() => appendFile(errorLog, header + value, "utf8"))
        .catch(logError => {
          console.error("Não foi possível atualizar error.log:", logError);
        });
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", captureError);
    child.once("error", async error => {
      if (settled) return;
      settled = true;
      await stderrLogQueue;
      await recordFailure(printable, label, null, output, error);
      reject(error);
    });
    child.once("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      await stderrLogQueue;
      if (code === 0) {
        resolve({ output });
        return;
      }
      const error = new Error(
        label + " falhou. Código: " + (code ?? "indisponível") + "; sinal: " + (signal ?? "nenhum") + "."
      );
      await recordFailure(printable, label, code, output, error);
      reject(error);
    });
  });
}

async function main() {
  try {
    await access(path.join(root, "package.json"));

    const localDevelopment = await run(
      "git",
      ["branch", "--list", "development"],
      "1/5 · Verificando a branch development local"
    );

    if (localDevelopment.output.trim()) {
      await run(
        "git",
        ["switch", "development"],
        "2/5 · Selecionando a branch development"
      );
    } else {
      await run(
        "git",
        ["fetch", "origin", "development"],
        "2/5 · Buscando development no GitHub"
      );
      await run(
        "git",
        ["switch", "--track", "-c", "development", "origin/development"],
        "3/5 · Criando a branch local acompanhando origin/development"
      );
    }

    await run(
      "git",
      ["pull", "--ff-only", "origin", "development"],
      "3/5 · Atualizando o código de development"
    );
    await run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], "4/5 · Preparando dependências");
    await run("npm", ["run", "build-web"], "5/5 · Validando TypeScript e compilando a interface");

    console.log("\nBuild concluído. Abrindo o Nova Generator em modo de desenvolvimento...\n");
    await run(
      "npm",
      ["run", "tauri", "--workspace", "@nova-generator/desktop", "--", "dev"],
      "Inicializando o aplicativo desktop"
    );
  } catch (error) {
    if (error.message.startsWith("Execute este comando")) {
      await recordFailure("npm run start-dev", "Validação da pasta do projeto", null, "", error);
    }
    console.error("\nInicialização interrompida:", error.message);
    process.exitCode = 1;
  }
}

await main();
