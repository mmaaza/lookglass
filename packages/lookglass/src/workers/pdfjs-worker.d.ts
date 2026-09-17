/**
 * pdfjs-dist ships no types for its worker build. Only the handler's start-up
 * entry point is used, so only that is declared.
 */
declare module 'pdfjs-dist/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: {
    initializeFromPort(port: unknown): void;
  };
}
