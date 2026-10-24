// esbuild bundles these Tesseract scripts as text (see esbuild.config.mjs).
declare module "tesseract.js/dist/worker.min.js" {
  const source: string;
  export default source;
}
declare module "tesseract.js-core/tesseract-core-simd-lstm.wasm.js" {
  const source: string;
  export default source;
}
