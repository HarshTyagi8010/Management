import { createRequire } from 'node:module';
import path from 'node:path';
import pdfmake, { type DocumentDefinition } from 'pdfmake';

/**
 * PDF rendering (ADR-006): pdfmake with bundled Noto Sans (SIL OFL 1.1, has the
 * ₹ glyph U+20B9). Templates are code; nothing is fetched while rendering:
 * every URL is refused and only the two font files may be read from disk, so
 * document content can never make the renderer reach the network or the file
 * system (no SSRF or file-read surface).
 */
const require = createRequire(import.meta.url);
export const FONT_FILES = {
  regular: require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf'),
  bold: require.resolve('@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf'),
};
const allowed = new Set(Object.values(FONT_FILES).map((f) => path.resolve(f)));

let configured = false;
function configure() {
  if (configured) return;
  pdfmake.setFonts({ NotoSans: { normal: FONT_FILES.regular, bold: FONT_FILES.bold, italics: FONT_FILES.regular, bolditalics: FONT_FILES.bold } });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((file) => allowed.has(path.resolve(file)));
  configured = true;
}

/**
 * Renders a document definition. `createdAt` becomes the PDF creation date, so
 * metadata reflects the document, not the moment of rendering.
 */
export async function renderPdf(doc: DocumentDefinition, meta: { title: string; createdAt: Date }): Promise<Buffer> {
  configure();
  return pdfmake
    .createPdf({
      pageSize: 'A4',
      pageMargins: [36, 48, 36, 48],
      defaultStyle: { font: 'NotoSans', fontSize: 9, lineHeight: 1.15 },
      ...doc,
      info: { title: meta.title, creator: 'BizMgmt', producer: 'BizMgmt', creationDate: meta.createdAt, modDate: meta.createdAt },
    })
    .getBuffer();
}
