import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * 从 PDF 二进制中提取纯文本（用于剧本导入）。
 * 逐页取 TextContent，按 pdfjs 的 hasEOL 还原换行，尽量保留段落与集级标记的行首锚定，
 * 保证下游 splitScriptIntoChunks / parseScriptJS 的行首正则仍可命中。
 * 仅支持文字层 PDF；扫描版（纯图像）PDF 提取结果为空，由调用方按「无内容」处理。
 */
export async function extractPdfText(buffer) {
  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  let out = '';
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      for (const it of content.items) {
        if (typeof it.str !== 'string') continue;
        out += it.str;
        if (it.hasEOL) out += '\n';
      }
      out += '\n'; // 页间空行，避免跨页粘连
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/** 判断上传文件是否为 PDF（按扩展名与 MIME 双重判定，兼容浏览器差异） */
export function isPdfFile(file = {}) {
  const name = String(file.originalname || file.name || '').toLowerCase();
  const mime = String(file.mimetype || file.type || '').toLowerCase();
  return name.endsWith('.pdf') || mime === 'application/pdf' || mime === 'application/x-pdf';
}
