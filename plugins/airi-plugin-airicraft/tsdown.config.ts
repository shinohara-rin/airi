import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { extension: './src/index.ts' },
  format: 'esm',
  dts: false,
  // The host loads one file, so the SDK stays bundled in.
  deps: { alwaysBundle: [/^@proj-airi\//] },
})
