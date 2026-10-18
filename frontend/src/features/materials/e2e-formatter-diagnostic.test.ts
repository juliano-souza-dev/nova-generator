import { it } from "vitest";

it("temporary formatter diagnostic for WAV browser test", async () => {
  const prettier = await import("prettier");
  const fs = await import("node:fs/promises");
  const path = "e2e/material-wav-action.spec.ts";
  const config = await prettier.resolveConfig(path);
  const formatted = await prettier.format(await fs.readFile(path, "utf8"), {
    ...config,
    filepath: path,
  });
  console.log("<<<FORMAT_BEGIN_WAV>>>");
  console.log(formatted);
  console.log("<<<FORMAT_END_WAV>>>");
});
