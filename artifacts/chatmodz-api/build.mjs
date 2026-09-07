import { build } from "esbuild"
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "dist/index.mjs",
  sourcemap: true,
})
