// Builds one package into dist/esm and dist/cjs with tsc, and marks each
// directory's module type so Node picks the right format.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const pkg = process.cwd();
const tsc = join(pkg, "..", "..", "node_modules", ".bin", "tsc");
rmSync(join(pkg, "dist"), { recursive: true, force: true });
for (const [dir, module, type] of [["esm", "ES2020", "module"], ["cjs", "CommonJS", "commonjs"]]) {
  execFileSync(tsc, ["-p", "tsconfig.json", "--outDir", `dist/${dir}`, "--module", module], { stdio: "inherit", cwd: pkg });
  mkdirSync(join(pkg, "dist", dir), { recursive: true });
  writeFileSync(join(pkg, "dist", dir, "package.json"), JSON.stringify({ type }) + "\n");
}
