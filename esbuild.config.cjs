const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const config = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  outfile: "dist/extension.js",
  sourcemap: !production,
  minify: production,
  target: "node20"
};

if (watch) {
  esbuild.context(config).then(ctx => {
    ctx.watch();
    console.log("[watch] build started");
  });
} else {
  esbuild.build(config).then(() => {
    console.log("Build OK");
  }).catch(e => {
    console.error("Build failed:", e.message);
    process.exit(1);
  });
}
