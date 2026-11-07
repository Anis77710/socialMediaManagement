import { z } from "zod";
import type { Business, Lang, PrismaClient } from "../../generated/prisma/client.js";
import type { AiProvider } from "../../providers/ai/types.js";
import type { Env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import {
  containsReplacementCharacter,
  contentHash,
  devanagariRatio,
  extractFacts,
  validateNumericGuard,
  type ExtractedFacts,
  type FactIssue,
} from "./facts.js";

const aiSchema = z.object({
  eyebrow: z.string().trim().min(1).max(40),
  headline: z.string().trim().min(1).max(60),
  caption: z.string().trim().min(1).max(2200),
  hashtags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});

export type CreativeTexts = z.infer<typeof aiSchema>;

export type GeneratedCreative = {
  facts: ExtractedFacts;
  texts: CreativeTexts;
  templateKey: string;
  inverted: boolean;
  contentHash: string;
  aiMeta: Record<string, unknown> | null;
  validation: {
    numericGuard: { ok: boolean; offending: string[] };
    devanagariRatio: number;
    replacementCharacter: boolean;
    issues: FactIssue[];
  };
};

const TEMPLATES = [
  {
    key: "bold-offer",
    inverted: false,
    eyebrow: (facts: ExtractedFacts) => (facts.primary ? "आजको अफर" : "नयाँ सूचना"),
    headline: (facts: ExtractedFacts) =>
      facts.primary ? `${facts.primary.text} ${facts.primary.unit === "off" ? "छुट" : "मात्र"}` : "आजै आउनुहोस्",
  },
  {
    key: "clean-value",
    inverted: true,
    eyebrow: (_facts: ExtractedFacts) => "विशेष अफर",
    headline: (facts: ExtractedFacts) =>
      facts.primary ? `${facts.primary.text} ${facts.primary.unit === "off" ? "छुट" : "बाट सुरु"}` : "तपाईंको पसल",
  },
  {
    key: "festival-warm",
    inverted: false,
    eyebrow: (_facts: ExtractedFacts) => "शुभकामना",
    headline: (facts: ExtractedFacts) =>
      facts.primary ? `${facts.primary.text} ${facts.primary.unit === "off" ? "छुट" : "मा उपलब्ध"}` : "आजै भेट्न आउनुहोस्",
  },
] as const;

function pickTemplate(seed: string): (typeof TEMPLATES)[number] {
  let hash = 0;

  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return TEMPLATES[hash % TEMPLATES.length] ?? TEMPLATES[0];
}

function fallbackCaption(business: Business, facts: ExtractedFacts, texts: CreativeTexts): string {
  const phone = business.customerPhone ?? facts.phones[0] ?? null;
  const lines = [
    texts.headline,
    "",
    `${business.name}${business.townText ? `, ${business.townText}` : ""}`,
    facts.primary
      ? facts.primary.unit === "off"
        ? `आज ${facts.primary.text} छुट।`
        : `मूल्य ${facts.primary.text}${facts.primary.unit === "from" ? " देखि" : ""}।`
      : "",
    phone ? `सम्पर्क: ${phone}` : "",
  ];

  return lines.filter((line) => line !== "").join("\n");
}

export function createContentService(deps: {
  prisma: PrismaClient;
  ai: AiProvider;
  env: Env;
}) {
  async function glossaryTerms(lang: Lang): Promise<{ term: string; preferred: string }[]> {
    return deps.prisma.glossary.findMany({
      where: { lang },
      select: { term: true, preferred: true },
      take: 200,
    });
  }

  function applyGlossary(text: string, glossary: { term: string; preferred: string }[]): string {
    return glossary.reduce(
      (value, entry) =>
        value.replace(new RegExp(entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), entry.preferred),
      text,
    );
  }

  async function generate(input: {
    business: Business;
    brief: string;
    language: Lang;
    occasion?: string | null;
    seed?: string;
    templateKey?: string;
    inverted?: boolean;
  }): Promise<GeneratedCreative> {
    const extracted = extractFacts(input.brief);

    if (extracted.issues.some((issue) => issue.code === "FACT_CONFLICT" || issue.code === "FACT_OUT_OF_RANGE")) {
      throw new AppError(422, "FACT_CONFLICT", "The brief contains conflicting or out-of-range offer facts", {
        issues: extracted.issues,
      });
    }

    const template = pickTemplate(
      input.seed ?? `${input.business.id}:${input.brief}:${input.occasion ?? ""}`,
    );
    const glossary = await glossaryTerms(input.language);
    const fallback: CreativeTexts = {
      eyebrow: applyGlossary(template.eyebrow(extracted.facts), glossary),
      headline: applyGlossary(template.headline(extracted.facts), glossary),
      caption: "",
      hashtags: [],
    };
    fallback.caption = applyGlossary(
      fallbackCaption(input.business, extracted.facts, fallback),
      glossary,
    );

    let texts = fallback;
    let aiMeta: Record<string, unknown> | null = null;

    if (deps.env.AI_DRIVER === "anthropic") {
      try {
        const result = await deps.ai.json({
          model: deps.env.AI_MODEL_CAPTION,
          system: [
            "You write short Nepali social media poster copy for a small business.",
            "Use only the facts provided. Never invent numbers, prices, discounts, or phone numbers.",
            "Nepali (Devanagari) is required unless the requested language is English.",
            "Return JSON with eyebrow, headline, caption, hashtags.",
          ].join(" "),
          user: JSON.stringify({
            business: input.business.name,
            town: input.business.townText,
            phone: input.business.customerPhone,
            language: input.language,
            occasion: input.occasion,
            brief: input.brief,
            facts: extracted.facts,
          }),
          schema: aiSchema,
          maxTokens: 700,
          timeoutMs: 20_000,
        });
        const candidate = {
          ...result.data,
          eyebrow: applyGlossary(result.data.eyebrow, glossary),
          headline: applyGlossary(result.data.headline, glossary),
          caption: applyGlossary(result.data.caption, glossary),
        };
        const guard = validateNumericGuard(
          [candidate.eyebrow, candidate.headline, candidate.caption].join(" "),
          extracted.facts,
          input.business.customerPhone ? [input.business.customerPhone] : [],
        );

        if (guard.ok && !containsReplacementCharacter(candidate.caption)) {
          texts = candidate;
          aiMeta = { usage: result.usage };
        }
      } catch {
        texts = fallback;
      }
    }

    const joined = [texts.eyebrow, texts.headline, texts.caption].join(" ");
    const guard = validateNumericGuard(
      joined,
      extracted.facts,
      input.business.customerPhone ? [input.business.customerPhone] : [],
    );

    if (!guard.ok) {
      throw new AppError(422, "FACT_CONFLICT", "Generated copy contains unsupported numbers", {
        offending: guard.offending,
      });
    }

    return {
      facts: extracted.facts,
      texts: {
        ...texts,
        caption:
          texts.hashtags.length > 0
            ? `${texts.caption}\n\n${texts.hashtags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")}`
            : texts.caption,
      },
      templateKey: input.templateKey ?? template.key,
      inverted: input.inverted ?? template.inverted,
      contentHash: contentHash({
        templateKey: input.templateKey ?? template.key,
        texts: {
          eyebrow: texts.eyebrow,
          headline: texts.headline,
          caption: texts.caption,
        },
        facts: extracted.facts,
        inverted: input.inverted ?? template.inverted,
      }),
      aiMeta,
      validation: {
        numericGuard: guard,
        devanagariRatio: devanagariRatio(joined),
        replacementCharacter: containsReplacementCharacter(joined),
        issues: extracted.issues,
      },
    };
  }

  async function suggestions(businessId: string, categoryId: string, limit = 6) {
    const [ideas, festivals] = await Promise.all([
      deps.prisma.ideaTemplate.findMany({
        where: { active: true, OR: [{ categoryIds: { has: categoryId } }, { categoryIds: { isEmpty: true } }] },
        take: limit,
      }),
      deps.prisma.festival.findMany({
        where: {
          published: true,
          adDate: { gte: new Date() },
        },
        orderBy: { adDate: "asc" },
        take: limit,
      }),
    ]);

    return { ideas, festivals };
  }

  async function templates(occasion?: string) {
    return deps.prisma.copyTemplate.findMany({
      where: { active: true, ...(occasion ? { occasion } : {}) },
      orderBy: [{ occasion: "asc" }, { weight: "desc" }],
      take: 100,
    });
  }

  async function posterTemplates() {
    return deps.prisma.posterTemplate.findMany({
      where: { active: true },
      orderBy: { key: "asc" },
    });
  }

  async function glossary(lang?: Lang) {
    return deps.prisma.glossary.findMany({
      where: lang ? { lang } : undefined,
      orderBy: { term: "asc" },
    });
  }

  return { generate, suggestions, templates, posterTemplates, glossary, extractFacts };
}

export type ContentService = ReturnType<typeof createContentService>;
