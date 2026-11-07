import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { toBs } from "../src/lib/nepali.js";

const connectionString = process.env.DATABASE_URL ?? "";

if (!connectionString) {
  throw new Error("DATABASE_URL is required to seed the database");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const categories = [
  ["grocery", "किराना पसल", "Grocery", 1],
  ["restaurant", "रेस्टुरेन्ट", "Restaurant", 2],
  ["clothing", "कपडा पसल", "Clothing", 3],
  ["salon", "सैलुन", "Salon", 4],
  ["electronics", "इलेक्ट्रोनिक्स", "Electronics", 5],
  ["pharmacy", "फार्मेसी", "Pharmacy", 6],
  ["bakery", "बेकरी", "Bakery", 7],
  ["services", "सेवा", "Services", 8],
  ["hardware", "हार्डवेयर", "Hardware", 9],
  ["stationery", "स्टेशनरी", "Stationery", 10],
] as const;

const towns = [
  ["Kathmandu", "काठमाडौं", "Kathmandu", 3, ["bagmati", "capital"]],
  ["Lalitpur", "ललितपुर", "Lalitpur", 3, ["bagmati", "capital"]],
  ["Bhaktapur", "भक्तपुर", "Bhaktapur", 3, ["bagmati", "capital"]],
  ["Pokhara", "पोखरा", "Kaski", 4, ["gandaki", "tourist"]],
  ["Bharatpur", "भरतपुर", "Chitwan", 3, ["bagmati", "terai"]],
  ["Biratnagar", "विराटनगर", "Morang", 1, ["koshi", "terai"]],
  ["Butwal", "बुटवल", "Rupandehi", 5, ["lumbini", "terai"]],
  ["Dharan", "धरान", "Sunsari", 1, ["koshi", "terai"]],
] as const;

const plans = [
  {
    id: "free",
    name: "Free",
    pricePaisa: 0,
    postsPerPeriod: 1,
    reelsPerPeriod: 0,
    maxAccounts: 1,
    quotaPeriod: "LIFETIME" as const,
    features: { approval: true, analytics: "basic", support: "community" },
    sortOrder: 1,
  },
  {
    id: "basic",
    name: "Basic",
    pricePaisa: 49_900,
    postsPerPeriod: 30,
    reelsPerPeriod: 4,
    maxAccounts: 3,
    quotaPeriod: "SUBSCRIPTION" as const,
    features: { approval: true, analytics: "basic", support: "email" },
    sortOrder: 2,
  },
  {
    id: "standard",
    name: "Standard",
    pricePaisa: 99_900,
    postsPerPeriod: 90,
    reelsPerPeriod: 15,
    maxAccounts: 10,
    quotaPeriod: "SUBSCRIPTION" as const,
    features: { approval: true, analytics: "full", autopilot: true, support: "priority" },
    sortOrder: 3,
  },
  {
    id: "premium",
    name: "Premium",
    pricePaisa: 199_900,
    postsPerPeriod: 300,
    reelsPerPeriod: 60,
    maxAccounts: 25,
    quotaPeriod: "SUBSCRIPTION" as const,
    features: {
      approval: true,
      analytics: "full",
      autopilot: true,
      adManagement: true,
      support: "dedicated",
    },
    sortOrder: 4,
  },
];

function festival(
  slug: string,
  nameNe: string,
  nameEn: string,
  date: string,
  kind: string,
  leadTimeDays: number,
  keywords: string[],
) {
  const adDate = new Date(`${date}T00:00:00.000Z`);
  const bs = toBs(adDate);

  return {
    slug,
    nameNe,
    nameEn,
    adDate,
    bsYear: bs?.year ?? 2083,
    bsMonth: bs?.month ?? 1,
    bsDay: bs?.day ?? 1,
    kind,
    regionTags: ["all"],
    categoryRelevance: { grocery: 3, restaurant: 3, clothing: 2, electronics: 2 },
    leadTimeDays,
    keywords,
    published: true,
  };
}

const festivals = [
  festival("chhath-2026", "छठ पर्व", "Chhath", "2026-11-15", "religious", 14, ["छठ", "chhath"]),
  festival("christmas-2026", "क्रिसमस", "Christmas", "2026-12-25", "festival", 21, ["क्रिसमस", "christmas"]),
  festival("new-year-2027", "नयाँ वर्ष", "New Year", "2027-01-01", "festival", 21, ["नयाँ वर्ष", "new year"]),
  festival("maghe-sankranti-2027", "माघे संक्रान्ति", "Maghe Sankranti", "2027-01-14", "cultural", 14, ["माघे", "sankranti"]),
  festival("holi-2027", "होली", "Holi", "2027-03-22", "festival", 21, ["होली", "holi"]),
  festival("nepali-new-year-2027", "नेपाली नयाँ वर्ष", "Nepali New Year", "2027-04-14", "cultural", 21, ["नयाँ वर्ष", "baisakh"]),
  festival("dashain-2027", "दशैं", "Dashain", "2027-10-09", "religious", 30, ["दशैं", "dashain"]),
];

const copyTemplates = [
  ["NE", "offer", "headline", "आज {{value}} छुट!", ["grocery", "clothing", "electronics"]],
  ["NE", "offer", "headline", "{{value}} छुट पाउनुहोस्", ["grocery", "salon"]],
  ["NE", "offer", "eyebrow", "आजको विशेष अफर", []],
  ["NE", "offer", "caption", "{{business}} मा आज {{value}} छुट। अहिले नै आउनुहोस्।", []],
  ["NE", "festival", "headline", "शुभकामना!", []],
  ["NE", "festival", "caption", "{{business}} परिवारबाट सबैलाई शुभकामना।", []],
  ["NE", "general", "headline", "आजै भेट्न आउनुहोस्", []],
  ["NE", "general", "caption", "{{business}}, {{town}} मा तपाईंलाई स्वागत छ।", []],
  ["EN", "offer", "headline", "{{value}} off today!", ["grocery", "clothing", "electronics"]],
  ["EN", "offer", "caption", "Visit {{business}} today for {{value}} off.", []],
  ["EN", "festival", "headline", "Warm wishes!", []],
  ["EN", "general", "headline", "Visit us today", []],
] as const;

const ideaTemplates = [
  {
    key: "grocery-weekly-offer",
    titleNe: "यो हप्ताको अफर",
    titleEn: "This week's offer",
    whyNe: "नियमित ग्राहकलाई फर्काउन उपयुक्त",
    whyEn: "Brings regular customers back",
    briefNe: "यो हप्ता ताजा सामानमा १०% छुट दिनुहोस्।",
    briefEn: "Offer 10% off fresh items this week.",
    categoryIds: ["grocery"],
  },
  {
    key: "restaurant-lunch",
    titleNe: "दिउँसोको खाना अफर",
    titleEn: "Lunch offer",
    whyNe: "दिउँसोको समयमा ग्राहक बढाउँछ",
    whyEn: "Boosts lunchtime footfall",
    briefNe: "दिउँसो १२ बजेदेखि ३ बजेसम्म विशेष मेनु देखाउनुहोस्।",
    briefEn: "Promote a special lunch menu from 12 to 3.",
    categoryIds: ["restaurant"],
  },
  {
    key: "clothing-new-arrival",
    titleNe: "नयाँ कपडा आयो",
    titleEn: "New arrivals",
    whyNe: "नयाँ सङ्कलनको जानकारी दिन्छ",
    whyEn: "Announces the new collection",
    briefNe: "नयाँ सङ्कलन आएको जानकारी दिनुहोस्।",
    briefEn: "Announce the new clothing collection.",
    categoryIds: ["clothing"],
  },
  {
    key: "salon-glow",
    titleNe: "चाडपर्वको तयारी",
    titleEn: "Festival glow-up",
    whyNe: "चाडपर्व अघि बुकिङ बढाउँछ",
    whyEn: "Drives bookings before festivals",
    briefNe: "चाडपर्वका लागि विशेष प्याकेज देखाउनुहोस्।",
    briefEn: "Promote a festival beauty package.",
    categoryIds: ["salon"],
  },
  {
    key: "electronics-warranty",
    titleNe: "वारेन्टी सहित",
    titleEn: "With warranty",
    whyNe: "विश्वास बढाउँछ",
    whyEn: "Builds trust",
    briefNe: "वारेन्टी सहितको नयाँ उत्पादन देखाउनुहोस्।",
    briefEn: "Showcase a new product with warranty.",
    categoryIds: ["electronics"],
  },
  {
    key: "general-thank-you",
    titleNe: "धन्यवाद",
    titleEn: "Thank you",
    whyNe: "ग्राहकसँगको सम्बन्ध बलियो बनाउँछ",
    whyEn: "Strengthens customer relationships",
    briefNe: "ग्राहकलाई धन्यवाद दिनुहोस्।",
    briefEn: "Thank your customers.",
    categoryIds: [],
  },
];

async function main(): Promise<void> {
  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { id: plan.id },
      create: plan,
      update: plan,
    });
  }

  for (const [id, nameNe, nameEn, sortOrder] of categories) {
    await prisma.businessCategory.upsert({
      where: { id },
      create: { id, nameNe, nameEn, sortOrder },
      update: { nameNe, nameEn, sortOrder, active: true },
    });
  }

  for (const [nameEn, nameNe, district, province, regionTags] of towns) {
    const existing = await prisma.town.findFirst({ where: { nameEn } });

    if (existing) {
      await prisma.town.update({
        where: { id: existing.id },
        data: { nameNe, district, province, regionTags: [...regionTags] },
      });
    } else {
      await prisma.town.create({
        data: { nameEn, nameNe, district, province, regionTags: [...regionTags] },
      });
    }
  }

  for (const entry of festivals) {
    await prisma.festival.upsert({
      where: { slug: entry.slug },
      create: entry,
      update: entry,
    });
  }

  await prisma.copyTemplate.deleteMany({ where: { reviewedById: null } });

  for (const [lang, occasion, slot, text, categoryIds] of copyTemplates) {
    await prisma.copyTemplate.create({
      data: {
        lang,
        occasion,
        slot,
        text,
        categoryIds: [...categoryIds],
      },
    });
  }

  for (const idea of ideaTemplates) {
    await prisma.ideaTemplate.upsert({
      where: { key: idea.key },
      create: idea,
      update: idea,
    });
  }

  const posters = [
    {
      key: "bold-offer",
      aspect: "4:5",
      htmlSource: "<div class=\"poster bold\">{{eyebrow}}<h1>{{headline}}</h1><p>{{value}}</p></div>",
    },
    {
      key: "clean-value",
      aspect: "4:5",
      htmlSource: "<div class=\"poster clean\"><h1>{{headline}}</h1><p>{{value}} {{unit}}</p></div>",
    },
    {
      key: "festival-warm",
      aspect: "4:5",
      htmlSource: "<div class=\"poster festival\"><p>{{eyebrow}}</p><h1>{{headline}}</h1></div>",
    },
  ];

  for (const poster of posters) {
    await prisma.posterTemplate.upsert({
      where: { key: poster.key },
      create: poster,
      update: poster,
    });
  }

  const glossary = [
    ["NE", "discount", "छुट"],
    ["NE", "offer", "अफर"],
    ["NE", "free", "निःशुल्क"],
    ["NE", "shop", "पसल"],
    ["EN", "discount", "discount"],
    ["EN", "offer", "offer"],
  ] as const;

  for (const [lang, term, preferred] of glossary) {
    await prisma.glossary.upsert({
      where: { lang_term: { lang, term } },
      create: { lang, term, preferred },
      update: { preferred },
    });
  }

  for (const key of ["autopilot", "ai_wording", "sample_data", "festival_campaigns"]) {
    await prisma.featureFlag.upsert({
      where: { key },
      create: { key, enabled: false },
      update: {},
    });
  }

  await prisma.systemSetting.upsert({
    where: { key: "support" },
    create: {
      key: "support",
      value: { phone: "+9779800000000", email: "support@redflie.com" },
    },
    update: {},
  });

  console.log("Seed complete");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
