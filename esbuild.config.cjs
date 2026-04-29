const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

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

// sql.js WASM binary must be present alongside extension.js at runtime.
function copySqlWasm() {
  const src = path.join(__dirname, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  const dst = path.join(__dirname, "dist", "sql-wasm.wasm");
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log("Copied sql-wasm.wasm → dist/");
  } else {
    console.warn("sql-wasm.wasm not found — run `npm install sql.js` first");
  }
}

if (watch) {
  esbuild.context(config).then(ctx => {
    copySqlWasm();
    ctx.watch();
    console.log("[watch] build started");
  });
} else {
  esbuild.build(config).then(() => {
    copySqlWasm();
    console.log("Build OK");
  }).catch(e => {
    console.error("Build failed:", e.message);
    process.exit(1);
  });
}
