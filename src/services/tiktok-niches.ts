/**
 * The niche taxonomy behind the hook corpus.
 *
 * Why a bounded list rather than free-text keywords: the corpus is cached, and
 * a cache key an agent can invent fragments it beyond usefulness. "fitness
 * tips", "fitness tip" and "gym tips" would be three separate paid collections
 * that never amortise, so a free-text key makes the whole thing cost more the
 * more it is used. A closed set of niches means the Nth agent asking about
 * fitness is served from the same rows as the first.
 *
 * Callers are NOT forced to know the list. Anything they pass resolves to the
 * nearest niche and the answer states which one it resolved to — flexible
 * input, bounded cost, and no silent substitution of a niche they did not ask
 * for.
 *
 * Each niche carries several DIFFERENT queries rather than one. Four pages of
 * a single search return four pages of much the same content; four distinct
 * angles return a sample varied enough for a pattern to mean something.
 */

export interface Niche {
  /** Canonical id — the cache key. */
  id: string;
  label: string;
  /** Distinct searches that together cover the niche. */
  queries: string[];
  /** Extra words that should resolve here. The id and label always do. */
  aliases: string[];
}

export const NICHES: Niche[] = [
  { id: "fitness", label: "Fitness & training", queries: ["fitness tips", "workout routine", "gym motivation", "home workout"], aliases: ["gym", "workout", "bodybuilding", "training", "exercise", "crossfit", "calisthenics", "running", "yoga", "pilates"] },
  { id: "nutrition", label: "Nutrition & diet", queries: ["nutrition tips", "healthy meal prep", "weight loss diet", "high protein meals"], aliases: ["diet", "weightloss", "protein", "macros", "supplements", "keto", "vegan"] },
  { id: "cooking", label: "Cooking & food", queries: ["easy recipe", "cooking hack", "dinner idea", "baking recipe"], aliases: ["food", "recipe", "baking", "sourdough", "chef", "kitchen", "meal", "dessert", "bbq"] },
  { id: "finance", label: "Personal finance", queries: ["money tips", "personal finance advice", "investing for beginners", "saving money"], aliases: ["money", "investing", "stocks", "budget", "wealth", "trading", "crypto", "passive income", "debt"] },
  { id: "business", label: "Business & entrepreneurship", queries: ["small business tips", "entrepreneur advice", "start a business", "business growth"], aliases: ["entrepreneur", "startup", "ecommerce", "dropshipping", "agency", "saas", "sales", "b2b"] },
  { id: "marketing", label: "Marketing & social media", queries: ["social media marketing", "content strategy", "grow on tiktok", "marketing tips"], aliases: ["socialmedia", "content", "branding", "seo", "ads", "copywriting", "growth", "creator"] },
  { id: "tech", label: "Tech & gadgets", queries: ["tech tips", "gadget review", "iphone tricks", "best apps"], aliases: ["technology", "gadgets", "apps", "software", "ai", "coding", "programming", "developer", "computer"] },
  { id: "beauty", label: "Beauty & skincare", queries: ["skincare routine", "makeup tutorial", "beauty tips", "glowing skin"], aliases: ["makeup", "skincare", "cosmetics", "hair", "nails", "grwm", "aesthetic"] },
  { id: "fashion", label: "Fashion & style", queries: ["outfit ideas", "style tips", "fashion haul", "how to style"], aliases: ["style", "outfit", "clothing", "streetwear", "thrift", "ootd", "wardrobe"] },
  { id: "travel", label: "Travel", queries: ["travel tips", "budget travel", "hidden places to visit", "travel hacks"], aliases: ["vacation", "trip", "backpacking", "flights", "hotels", "destinations", "adventure"] },
  { id: "parenting", label: "Parenting & family", queries: ["parenting tips", "toddler activities", "mom hacks", "newborn advice"], aliases: ["mom", "dad", "baby", "kids", "family", "toddler", "pregnancy", "motherhood"] },
  { id: "pets", label: "Pets & animals", queries: ["dog training tips", "cat behaviour", "pet care", "puppy training"], aliases: ["dog", "cat", "puppy", "animal", "petcare", "veterinary", "training dog"] },
  { id: "home", label: "Home & DIY", queries: ["home improvement", "diy project", "cleaning hacks", "home organisation"], aliases: ["diy", "cleaning", "organisation", "organization", "interior", "renovation", "decor", "garden"] },
  { id: "realestate", label: "Real estate", queries: ["real estate tips", "first time home buyer", "property investing", "housing market"], aliases: ["property", "housing", "mortgage", "realtor", "landlord", "rental"] },
  { id: "cars", label: "Cars & automotive", queries: ["car tips", "car maintenance", "car review", "car detailing"], aliases: ["auto", "automotive", "vehicle", "mechanic", "detailing", "ev", "motorcycle"] },
  { id: "gaming", label: "Gaming", queries: ["gaming tips", "game review", "gaming setup", "pro gamer tricks"], aliases: ["game", "gamer", "esports", "console", "pc gaming", "streamer", "minecraft", "fortnite"] },
  { id: "education", label: "Education & study", queries: ["study tips", "learn faster", "exam preparation", "study routine"], aliases: ["study", "school", "college", "university", "student", "learning", "revision", "exams"] },
  { id: "career", label: "Career & jobs", queries: ["career advice", "job interview tips", "resume tips", "workplace advice"], aliases: ["job", "interview", "resume", "cv", "hiring", "linkedin", "salary", "work"] },
  { id: "health", label: "Health & medical", queries: ["health tips", "doctor advice", "sleep better", "gut health"], aliases: ["medical", "doctor", "wellness", "sleep", "mental health", "anxiety", "therapy", "nurse"] },
  { id: "motivation", label: "Motivation & self-improvement", queries: ["motivation", "self improvement", "discipline habits", "morning routine"], aliases: ["mindset", "discipline", "habits", "productivity", "selfhelp", "success", "routine"] },
  { id: "comedy", label: "Comedy & entertainment", queries: ["funny skit", "comedy sketch", "relatable comedy", "prank"], aliases: ["funny", "humor", "humour", "skit", "meme", "entertainment", "prank"] },
  { id: "music", label: "Music", queries: ["music tips", "learn guitar", "music production", "singing tips"], aliases: ["guitar", "piano", "producer", "singing", "band", "songwriting", "dj"] },
  { id: "art", label: "Art & design", queries: ["art tutorial", "drawing tips", "graphic design tips", "digital art"], aliases: ["drawing", "painting", "design", "illustration", "graphic", "tattoo", "craft"] },
  { id: "sports", label: "Sports", queries: ["sports highlights", "football skills", "basketball training", "sports analysis"], aliases: ["football", "soccer", "basketball", "nba", "nfl", "tennis", "boxing", "mma", "golf"] },
];

export const NICHE_IDS = NICHES.map((n) => n.id);

export function getNiche(id: string): Niche | undefined {
  return NICHES.find((n) => n.id === id);
}

export interface NicheResolution {
  niche: Niche;
  /** What the caller asked for. */
  requested: string;
  /** True when the request was not itself a canonical id — say so, never substitute silently. */
  resolved: boolean;
  /** How the match was made, so a surprising resolution is explainable. */
  via: "id" | "alias" | "label" | "word" | "fallback";
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[#_-]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Map anything a caller passes onto a niche.
 *
 * Never returns null: an unmatched request falls back rather than failing,
 * because refusing "sourdough" when "cooking" is plainly the right shelf helps
 * nobody. What matters is that the answer always reports which niche was used
 * and whether it differed from the request, so a caller can tell a direct hit
 * from a best guess.
 */
export function resolveNiche(requested: string): NicheResolution | null {
  const q = normalise(requested || "");
  if (!q) return null;

  const exact = NICHES.find((n) => n.id === q);
  if (exact) return { niche: exact, requested, resolved: false, via: "id" };

  // Compare with spaces removed too. People write "weight loss" where the
  // alias is "weightloss", "real estate" where it is "realestate" — the
  // spacing is not a different request, and treating it as one sends a
  // perfectly clear ask to the fallback.
  const compact = (v: string) => normalise(v).replace(/ /g, "");
  const qc = compact(requested);

  const byAlias = NICHES.find((n) => n.aliases.some((a) => normalise(a) === q || compact(a) === qc));
  if (byAlias) return { niche: byAlias, requested, resolved: true, via: "alias" };

  const byId = NICHES.find((n) => compact(n.id) === qc);
  if (byId) return { niche: byId, requested, resolved: true, via: "id" };

  const byLabel = NICHES.find((n) => normalise(n.label) === q || compact(n.label) === qc);
  if (byLabel) return { niche: byLabel, requested, resolved: true, via: "label" };

  // Word-level overlap, longest alias first so "real estate" beats "estate".
  const words = q.split(" ").filter(Boolean);
  let best: { niche: Niche; score: number } | null = null;
  for (const n of NICHES) {
    const terms = [n.id, ...n.aliases, ...normalise(n.label).split(" ")].map(normalise).filter(Boolean);
    let score = 0;
    for (const t of terms) {
      if (!t) continue;
      if (q === t) score += 10;
      else if (q.includes(t) && t.length >= 4) score += t.length;
      else if (words.includes(t)) score += t.length;
    }
    if (score > 0 && (!best || score > best.score)) best = { niche: n, score };
  }
  if (best) return { niche: best.niche, requested, resolved: true, via: "word" };

  return null;
}
