import { it } from "vitest";

it("temporary exact formatter output for material files", async () => {
  const prettier = await import("prettier");
  const fs = await import("node:fs/promises");
  const paths = [
    ["PAGE", "src/features/materials/MaterialsPage.tsx"],
    ["TEST", "src/features/materials/MaterialsPage.test.tsx"],
    ["CSS", "src/features/materials/materials.css"],
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
