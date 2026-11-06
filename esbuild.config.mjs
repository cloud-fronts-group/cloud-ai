// Build script for the extension host bundle.
// `node esbuild.config.mjs` → one-shot build; `--watch` → rebuild on change.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20", // VS Code ^1.95 ships Node 20
  external: ["vscode"], // provided by the extension host at runtime
  sourcemap: true, // kept out of the VSIX via .vscodeignore
  minify: false,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("[esbuild] watching…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
