import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PDFDocument, PDFImage } from "pdf-lib";
import { site } from "../site";

// Unit artwork (small PNGs made from public/units by design/pdf-assets.py) and the business logo.
// Files are read from disk once per server instance; anything missing is left out of the PDF.

const ART_DIR = () => path.join(process.cwd(), "src/lib/pdf/assets");
const files = new Map<string, Buffer | null>();

function read(file: string): Buffer | undefined {
  if (!files.has(file)) {
    try {
      files.set(file, readFileSync(file));
    } catch {
      files.set(file, null);
    }
  }
  return files.get(file) ?? undefined;
}

/** Embed the named artwork once in this document. */
export async function embedArt(doc: PDFDocument, names: Iterable<string>): Promise<Map<string, PDFImage>> {
  const out = new Map<string, PDFImage>();
  for (const name of new Set(names)) {
    const bytes = read(path.join(ART_DIR(), `${name}.png`));
    if (!bytes) continue;
    try {
      out.set(name, await doc.embedPng(bytes));
    } catch {
      // A damaged file just means no picture.
    }
  }
  return out;
}

export type Logo = { kind: "svg"; paths: string[]; width: number; height: number } | { kind: "png"; image: PDFImage };

/** The business logo from site.ts: SVG paths (drawn as vectors in any color) or a PNG. */
export async function embedLogo(doc: PDFDocument): Promise<Logo | undefined> {
  const src = site.business.enabled ? site.business.logo : site.header.enabled ? site.header.logo : "";
  if (!src || /^https?:/.test(src)) return undefined;
  const bytes = read(path.join(process.cwd(), "public", src.replace(/^\/+/, "")));
  if (!bytes) return undefined;
  if (src.endsWith(".png")) {
    try {
      return { kind: "png", image: await doc.embedPng(bytes) };
    } catch {
      return undefined;
    }
  }
  if (!src.endsWith(".svg")) return undefined;
  const svg = bytes.toString("utf8");
  // Plain path-only logos (no transforms); anything fancier falls back to the business name in text.
  if (/transform=|<(?:use|image|text)\b/.test(svg)) return undefined;
  const box = svg.match(/viewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/);
  const paths = [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (!box || Number(box[1]) || Number(box[2]) || !paths.length) return undefined;
  return { kind: "svg", paths, width: Number(box[3]), height: Number(box[4]) };
}
