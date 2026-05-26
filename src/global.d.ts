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
