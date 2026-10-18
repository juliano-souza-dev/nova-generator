import { it } from "vitest";

it("temporary formatter diagnostic for Shadowing UI", async () => {
  const prettier = await import("prettier");
  const fs = await import("node:fs/promises");
  const paths = [
    ["PAGE", "src/features/shadowing/ShadowingPage.tsx"],
    ["TEST", "src/features/shadowing/ShadowingPage.test.tsx"],
  ] as const;
  for (const [id, path] of paths) {
    const config = await prettier.resolveConfig(path);
    const formatted = await prettier.format(await fs.readFile(path, "utf8"), {
      ...config,
      filepath: path,
    });
    console.log(`<<<FORMAT_BEGIN_${id}>>>`);
    console.log(formatted);
    console.log(`<<<FORMAT_END_${id}>>>`);
  }
});
