/**
 * pdf.js ships its worker as an ESM file without type declarations. The server
 * imports it explicitly so a bundled build can register the main-thread worker
 * handler (see extract.server.ts); only the shape we touch is declared here.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
