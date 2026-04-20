// Builds gold-examples.jsonl — 30 reference training examples (10 chunks × 3 input types)
// Format: ShareGPT (compatible with Unsloth, Axolotl, LLaMA-Factory)
// Reads: data/finetune/source-chunks.json
// Writes: data/finetune/gold-examples.jsonl

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "data/finetune/source-chunks.json");
const OUT = path.join(ROOT, "data/finetune/gold-examples.jsonl");

const SYSTEM = `You are a MECHANICUS knowledge encoder. You convert editorial wisdom from books about UX, copywriting, SEO, UI, and mobile design into compressed MECHANICUS-format chunks for a vector database.

SCHEMA (strict JSON, single object):
- principle: action-oriented transformation rule, 3-300 chars. NEVER a definition.
- explanation: MECHANICUS code, 10-500 chars. Format: X.<domain>|rule_label: instruction; NO:antipattern; eg: "before" >> "after"
- domain: one of "copy" | "seo" | "ux" | "ui" | "mobile" | "perf" | "research"
- tags: array of 1-10 kebab-case strings, specific to subtopic

OPERATORS:
-> sequence / leads to
== equivalence
!= not equal
+ combine
- removes
>> transformation (LEFT=bad, RIGHT=good)
NO: antipattern
eg: concrete example with before >> after

QUALITY RULE: The principle must let a practitioner TRANSFORM their work immediately. Definitions fail the /om test. Transformations pass.

OUTPUT: a single valid JSON object. No prose, no markdown fences, no commentary.`;

// Human input variants for each of the 10 picked chunks.
// T1 = source passage (simulated book excerpt 150-220 words)
// T2 = user question (practical query)
// T3 = brief idea (1-2 line tight hint)
const INPUTS = [
  // 0. copy: means-end chain
  {
    T1: `From "Breakthrough Advertising" by Eugene Schwartz:\n\nMost copywriters stop one level too early. They write about the feature — "256-bit AES encryption", "cloud-synced notebooks", "14-day free trial" — and assume the reader will do the translation. They will not. The reader's brain is tuned to one signal only: "what changes in my life if I buy this?"\n\nThe means-end chain forces you to trace the feature all the way down to the life outcome. Feature is the spec. Functional benefit is what the feature does. Emotional benefit is how that feels. Life value is the identity the reader earns by having it. Most copy stops at the functional layer and wonders why conversion is flat.\n\nThe method: take any feature and ask "so what?" three times in a row. "256-bit AES encryption." So what? "Your data is secure." So what? "You never wake up to a breach email." So what? "You keep the trust of the people who work for you." That last layer is where buying decisions actually happen. Encode this.`,
    T2: `Моя продающая страница подробно описывает все фичи продукта, пользователи читают, но не покупают. В чём ошибка?`,
    T3: `Идея из книги: features don't sell, life outcomes do. Закодируй в MECHANICUS.`,
  },

  // 1. copy: signup form microcopy
  {
    T1: `From a chapter on SaaS conversion copy:\n\nLook at the top of most signup forms and you'll see the same three words: "Create Account". These words describe the action the user is about to perform. They do not describe the reason. A signup form is one of the highest-friction moments in the funnel — this is the moment to sell, not to narrate.\n\nReframe the headline to state what the user gains: "Start building for free", "Join 12,000 makers", "Get your first dashboard in 30 seconds". Then — and this is the part most teams skip — address the top three fears inline, where the user is already looking. Spam: "No spam, ever." Privacy: "We never share your data." Commitment: "No credit card required. Cancel anytime." These can sit in a single row under the form as small muted text. That row resolves the objections the user would otherwise abandon over.\n\nThe form is no longer a registration transaction. It's a promise with receipts.`,
    T2: `Какой заголовок написать над формой регистрации SaaS, чтобы больше людей её заполняло?`,
    T3: `Форма signup — не "Create Account", а то что юзер получит + снять страхи рядом с полями.`,
  },

  // 2. mobile: iOS tabs vs nav controllers
  {
    T1: `From Apple Human Interface Guidelines:\n\niOS offers two fundamentally different navigation primitives, and confusing them is the single most common navigation bug in third-party apps. Tab bars switch between peer contexts — Home, Search, Profile — that are unrelated siblings. Each tab owns its own navigation stack; tapping a tab a second time returns to the root of that tab. Navigation controllers push and pop within a hierarchy — Inbox → Thread → Message — where every screen is a child of the previous one.\n\nThe antipattern emerges when developers push a detail screen that secretly swaps the selected tab, or embed a tab bar inside a pushed screen. Both break the user's mental model of where they are in the app. The rule is simple: tabs are always at the root and always visible; push navigation lives inside a single tab.\n\nWith five or fewer top-level sections, use a tab bar. Beyond five, use the More overflow tab — do not squeeze seven tabs onto the screen. Hierarchical content inside a tab always uses a navigation controller.`,
    T2: `В iOS приложении: нужно переключаться между Home / Search / Profile, а внутри Home — проваливаться в детали. Tab bar или navigation controller?`,
    T3: `iOS: tab bar для top-level секций, navigation controller для drill-down. Не смешивать.`,
  },

  // 3. mobile: Dynamic Type
  {
    T1: `From Apple HIG, accessibility chapter:\n\nUsers can scale iOS system text up to 310% of default size via the Accessibility Large Text setting. Many people — not just those with diagnosed visual impairments — rely on this. If your app hardcodes font sizes with UIFont.systemFont(ofSize: 14), your text will ignore the user's preference and the app becomes unusable at large sizes.\n\nThe fix is to use semantic text styles. Instead of fixed point sizes, reference UIFont.TextStyle.body, .headline, .caption, etc. These scale automatically with the user's setting. In SwiftUI, this is .font(.body) and the layer is transparent to you. For layouts that would break at 310% (toolbars, sidebars), use .dynamicTypeSize(.xSmall ... .accessibility5) to clamp within a usable range rather than refusing to scale at all.\n\nTest your app at XXXLarge and at accessibility5. Every screen. If content gets truncated or clipped, that is a real bug — not a tradeoff. The user chose that setting for a reason.`,
    T2: `Пользователь жалуется что при большом системном шрифте в моём iOS-приложении всё ломается. Как правильно сделать?`,
    T3: `iOS: support Dynamic Type через semantic text styles, не хардкодить размер.`,
  },

  // 4. seo: SVG for icons and logos
  {
    T1: `From "The Art of SEO":\n\nPicking the right image format is not a visual decision — it is a performance and crawlability decision. SVG, unlike JPEG or PNG, is not a pixel grid. It is an XML document describing shapes, and that changes what the browser and the search crawler can do with it.\n\nAn SVG logo scales from a 16×16 favicon to a 1200px hero image with zero quality loss and one file. A PNG logo requires you to export three or four raster versions, each compressed, each a separate HTTP request, none of them sharp at arbitrary zoom levels. For any icon, logo, chart, or line diagram — anything that is not a photograph — SVG wins on every axis that matters.\n\nSVG also ships as plain text. The labels and structure inside the file are readable by Googlebot without needing alt attributes. The file itself is usually under 5 KB, loads instantly, and animates with CSS. The only reason to fall back to PNG is if the asset genuinely requires photographic detail — and in that case it probably is a photograph and belongs in WebP or AVIF.`,
    T2: `Какой формат использовать для логотипа компании и иконок на сайте?`,
    T3: `Иконки, логотипы, диаграммы — SVG, не PNG. Закодируй.`,
  },

  // 5. seo: Google Business Profile
  {
    T1: `From "The Art of SEO", chapter on local SEO:\n\nThe Google Business Profile (formerly Google My Business) is the single most important lever for any business competing in local search. No amount of on-page SEO, backlink building, or content marketing will put you in the map pack without a verified GBP listing in the correct primary category. This is not a nice-to-have. This is the gate.\n\nVerification happens by postcard with a PIN, typically 10 to 14 days. Start this on day one. The primary category you select is the strongest ranking signal in local search — choose the most specific category that matches what you actually do. "Plumber" ranks differently from "Emergency plumbing service", and the wrong choice can keep you invisible for the searches that matter.\n\nOnce verified, the next lever is photos. A GBP listing with 20+ real job photos — before/after, team, premises — outranks a listing with stock imagery or none. Reviews compound over time, so start asking on day one. Never stuff keywords into the business name field; Google suspends listings for that, and the suspension process is slow.`,
    T2: `У меня кофейня в Варшаве. Как попасть в локальную выдачу Google (тот блок с картой)?`,
    T3: `Local SEO: GBP — фундамент. Verify, primary category, photos. Закодируй.`,
  },

  // 6. ui: empty dashboard state
  {
    T1: `From a SaaS onboarding design study:\n\nThe first time a new user lands on their dashboard, they see charts with no data, metrics reading zero, and widgets that look broken. At that moment, the user has no context for why it looks that way. They assume either the product is broken, or they set it up wrong. A significant percentage of them churn in the next sixty seconds.\n\nThe fix is to treat the empty first-run state as a designed flow, not an absence. Three components together solve it. First, an onboarding checklist widget anchored at the top of the dashboard: connect your data source, invite your team, configure your first alert — with per-item CTAs and a visible percentage-complete indicator. Second, sample data that populates every chart on signup, marked with a visible "Using sample data" badge, so the user sees what a working dashboard looks like. Third, each individual widget carries its own setup CTA for users who want to skip the checklist and configure one thing at a time.\n\nDo not ship a literal empty dashboard with a "No data yet" message. That is a dead end disguised as honesty.`,
    T2: `Новый пользователь заходит в мой SaaS дашборд, видит пустые графики и сразу уходит. Что поставить вместо пустоты?`,
    T3: `SaaS first-run empty dashboard: guided setup + sample data + per-widget CTA.`,
  },

  // 7. ui: hierarchy via weight and color
  {
    T1: `From "Refactoring UI" by Adam Wathan and Steve Schoger:\n\nJunior designers solve hierarchy by adding another font size. Label is smaller than title, caption is smaller than label, metadata is smaller than caption — and within a single card you end up with five different sizes competing. The type scale collapses, and the layout feels chaotic because every pair of adjacent elements introduces a new size relationship.\n\nThe senior move is to establish three levels of hierarchy at the same font size. Primary content uses weight 600 and a near-black color (gray-900). Secondary content uses weight 400 and a mid-gray (gray-500). Tertiary metadata uses weight 400 and a lighter gray (gray-400). All three are 16px. The hierarchy comes from the weight and color difference, not from size. The result is calm, readable, and fits inside a tighter type scale.\n\nThe test: can a reader scan the card and immediately identify the primary element, the supporting content, and the deprioritized metadata — at a single glance, with all three at the same font size? If yes, the hierarchy is working. If you had to reach for a second font size to make it work, simplify first.`,
    T2: `В карточке продукта название, подпись и мелкие мета-данные — как сделать иерархию, не плодя пять размеров шрифта?`,
    T3: `Иерархия на одном font-size через weight + color, не через size.`,
  },

  // 8. ux: hamburger → bottom tabs
  {
    T1: `From Nielsen Norman Group research on mobile navigation:\n\nEyetracking studies across dozens of mobile apps consistently show the same pattern: navigation hidden behind a hamburger icon is used roughly half as often as navigation that is always visible. Users explore fewer sections, discover fewer features, and report lower satisfaction — even when the destinations behind the hamburger are identical to those in a visible tab bar.\n\nThe hamburger seems like a clean solution because it removes chrome from the screen. In reality, it imposes a cognitive tax: the user must remember what lives inside, open it, scan a vertical list, and tap. A bottom tab bar with three to five labeled tabs makes the same destinations visible at all times, costs one tap instead of two, and supports rapid context switching that hamburger menus cannot.\n\nThe rule for apps with more than two core destinations is unambiguous: bottom tab bar, three to five items, always visible. Reserve the hamburger for rarely-used settings and account screens — never for the primary navigation of the product.`,
    T2: `В мобильном приложении 5 основных разделов (Лента, Поиск, Сообщения, Избранное, Профиль). Гамбургер-меню или bottom tab bar?`,
    T3: `Mobile app с 3-5 разделами: bottom tabs, не гамбургер.`,
  },

  // 9. ux: shipping costs on product page
  {
    T1: `From Baymard Institute e-commerce research:\n\nThe single largest driver of checkout abandonment is unexpected cost revealed at the last step. The user has spent minutes selecting the product, adding variants, entering shipping details — and then a line item for shipping appears that was never mentioned on the product page. At that point, trust is already broken. Even if the shipping cost is reasonable, the feeling of having been tricked is enough to close the tab.\n\nThe fix is architectural, not cosmetic. Every product page — and every product card in listing grids — must include a shipping line: the cost, the estimated delivery date, and the free-shipping threshold if one exists. "Free shipping over $50 · Arrives Thu–Fri" under the price tells the user exactly what to expect before they add to cart. It also lets users self-qualify: the person who will not pay $12 shipping leaves now, not at checkout, and does not generate an abandoned cart you then have to chase with email.\n\nDo not hide costs until checkout. Do not write "shipping calculated at checkout". Show the number.`,
    T2: `У нас e-commerce магазин — много брошенных корзин на шаге доставки. Люди пугаются цены шиппинга. Что делать?`,
    T3: `E-commerce: стоимость доставки и ETA — на product page, не на checkout.`,
  },
];

function main() {
  const chunks = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  const byDomain = {};
  chunks.forEach((c) => {
    if (!byDomain[c.domain]) byDomain[c.domain] = [];
    byDomain[c.domain].push(c);
  });

  const picks = [
    byDomain.copy[0],
    byDomain.copy[1],
    byDomain.mobile[0],
    byDomain.mobile[4],
    byDomain.seo[0],
    byDomain.seo[2],
    byDomain.ui[0],
    byDomain.ui[3],
    byDomain.ux[0],
    byDomain.ux[1],
  ];

  if (picks.length !== INPUTS.length) {
    throw new Error(`picks=${picks.length} but INPUTS=${INPUTS.length}`);
  }

  const examples = [];
  picks.forEach((chunk, i) => {
    const inputs = INPUTS[i];
    const output = JSON.stringify({
      principle: chunk.principle,
      explanation: chunk.explanation,
      domain: chunk.domain,
      tags: chunk.tags,
    });
    ["T1", "T2", "T3"].forEach((type) => {
      examples.push({
        conversations: [
          { from: "system", value: SYSTEM },
          { from: "human", value: inputs[type] },
          { from: "gpt", value: output },
        ],
        meta: {
          type,
          domain: chunk.domain,
          source_chunk_id: chunk.id,
          principle_head: chunk.principle.slice(0, 60),
        },
      });
    });
  });

  const jsonl = examples.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(OUT, jsonl, "utf8");
  console.log(`Wrote ${examples.length} examples to ${path.relative(ROOT, OUT)}`);
  console.log(`Bytes: ${Buffer.byteLength(jsonl, "utf8")}`);
}

main();
