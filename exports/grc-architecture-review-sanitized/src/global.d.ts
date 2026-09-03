declare module "mastra";

// The `openai` package is dynamically imported in a few places but not
// listed in package.json — declare a minimal shape so the import type-checks.
declare module "openai" {
  const OpenAI: any;
  export default OpenAI;
}

// pdfkit and pdf-parse ship JS only.
declare module "pdfkit" {
  const PDFDocument: any;
  export default PDFDocument;
}

declare module "pdf-parse" {
  const pdfParse: any;
  export default pdfParse;
}

// pg-query-stream 4.16.0 ships `dist/index.d.ts` AND declares top-level
// `"types"` in its package.json, but its `exports` map has no `"types"`
// condition. Under `moduleResolution: "bundler"` the exports map wins and
// the top-level `"types"` field is ignored — so TS can't find the typings
// (TS2307). This shim mirrors the upstream `dist/index.d.ts` so the dynamic
// `import("pg-query-stream")` in src/utils/excelExport.ts type-checks.
declare module "pg-query-stream" {
  import { Readable } from "stream";
  import { Submittable, Connection } from "pg";
  interface QueryStreamConfig {
    batchSize?: number;
    highWaterMark?: number;
    rowMode?: "array";
    types?: any;
  }
  class QueryStream extends Readable implements Submittable {
    cursor: any;
    _result: any;
    callback: Function;
    handleRowDescription: Function;
    handleDataRow: Function;
    handlePortalSuspended: Function;
    handleCommandComplete: Function;
    handleReadyForQuery: Function;
    handleError: Function;
    handleEmptyQuery: Function;
    constructor(text: string, values?: any[], config?: QueryStreamConfig);
    submit(connection: Connection): void;
    _destroy(_err: Error, cb: Function): void;
    _read(size: number): void;
  }
  export = QueryStream;
}
