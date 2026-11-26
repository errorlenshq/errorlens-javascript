// The <script> tag build of @errorlenshq/browser: one minified file that sets window.ErrorLens.
import { build } from "esbuild";

await build({
  entryPoints: ["dist/esm/index.js"],
  outfile: "dist/errorlens.min.js",
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "ErrorLens",
  target: "es2018",
  sourcemap: true,
  legalComments: "none",
});
