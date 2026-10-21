// Minimal typings for the parts of pdfmake 0.3 used here (the package ships none).
declare module 'pdfmake' {
  export type Content = unknown;
  export interface DocumentDefinition {
    content: Content;
    [key: string]: unknown;
  }
  export interface OutputDocument {
    getBuffer(): Promise<Buffer>;
  }
  interface PdfMake {
    setFonts(fonts: Record<string, Record<'normal' | 'bold' | 'italics' | 'bolditalics', string>>): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    createPdf(doc: DocumentDefinition, options?: Record<string, unknown>): OutputDocument;
  }
  const pdfmake: PdfMake;
  export default pdfmake;
}
