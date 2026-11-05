export type PosterInput = {
  templateKey: string;
  inverted: boolean;
  eyebrow: string;
  headline: string;
  value?: string | null;
  unit?: string | null;
  businessName: string;
  phone?: string | null;
  width?: number;
  height?: number;
};

export interface Renderer {
  name: string;
  poster(input: PosterInput): Promise<{ png: Buffer; jpeg: Buffer }>;
  pdf(html: string): Promise<Buffer>;
}
