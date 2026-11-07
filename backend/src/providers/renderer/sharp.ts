import PDFDocument from "pdfkit";
import sharp from "sharp";
import type { PosterInput, Renderer } from "./types.js";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (`${current} ${word}`.trim().length <= maxChars) {
      current = `${current} ${word}`.trim();
    } else {
      if (current) {
        lines.push(current);
      }

      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.slice(0, 5);
}

function svg(input: PosterInput): string {
  const width = input.width ?? 1080;
  const height = input.height ?? 1350;
  const background = input.inverted ? "#0a0a0a" : "#ffffff";
  const foreground = input.inverted ? "#ffffff" : "#0a0a0a";
  const headlineLines = wrap(input.headline, 18);
  const headlineStart = 560 - (headlineLines.length - 1) * 48;
  const headlineTspans = headlineLines
    .map(
      (line, index) =>
        `<tspan x="90" dy="${index === 0 ? 0 : 96}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  const value = input.value ? escapeXml(input.value) : "";
  const unit = input.unit ? escapeXml(input.unit) : "";
  const phone = input.phone ? escapeXml(input.phone) : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${background}"/>
  <text x="90" y="180" fill="${foreground}" font-family="Noto Sans Devanagari, Inter, sans-serif" font-size="40" letter-spacing="8">${escapeXml(input.eyebrow.toUpperCase())}</text>
  <text x="90" y="${headlineStart}" fill="${foreground}" font-family="Noto Sans Devanagari, Inter, sans-serif" font-size="88" font-weight="700">${headlineTspans}</text>
  <text x="90" y="900" fill="${foreground}" font-family="Archivo, Inter, sans-serif" font-size="180" font-weight="800">${value}</text>
  <text x="90" y="980" fill="${foreground}" font-family="Noto Sans Devanagari, Inter, sans-serif" font-size="44">${unit}</text>
  <rect x="90" y="1060" width="160" height="6" fill="${foreground}"/>
  <text x="90" y="1180" fill="${foreground}" font-family="Noto Sans Devanagari, Inter, sans-serif" font-size="38">${escapeXml(input.businessName)}</text>
  <text x="90" y="1240" fill="${foreground}" font-family="Inter, sans-serif" font-size="34">${phone}</text>
  <text x="${width - 90}" y="${height - 60}" text-anchor="end" fill="${foreground}" font-family="Inter, sans-serif" font-size="24" opacity="0.6">Redflie</text>
</svg>`;
}

export function createSharpRenderer(): Renderer {
  return {
    name: "sharp-svg",

    async poster(input) {
      const image = sharp(Buffer.from(svg(input)), { density: 144 });

      return {
        png: await image.clone().png({ compressionLevel: 9 }).toBuffer(),
        jpeg: await image.clone().jpeg({ quality: 90, mozjpeg: true }).toBuffer(),
      };
    },

    async pdf(html) {
      return new Promise<Buffer>((resolve, reject) => {
        const document = new PDFDocument({ size: "A4", margin: 50 });
        const chunks: Buffer[] = [];

        document.on("data", (chunk: Buffer) => chunks.push(chunk));
        document.on("end", () => resolve(Buffer.concat(chunks)));
        document.on("error", reject);
        const text = html
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim();
        document.fontSize(11).text(text);
        document.end();
      });
    },
  };
}
