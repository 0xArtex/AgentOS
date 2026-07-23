/**
 * Human-plausible local parts for disposable temp inboxes.
 *
 * Why not `tmp-<hex>`? Fraud-scoring signup validators (IPQS, SEON, Kickbox)
 * flag random/gibberish local parts as automation and raise the risk score,
 * even on a clean domain. A name like `maria.holt73@` reads as a real person
 * and clears those checks. The domain still carries most of the acceptance
 * weight (see config.tempEmailDomains), but the local part is a cheap win.
 *
 * Output charset is a strict subset of createInbox()'s sanitizer
 * (`[a-z0-9\-_.]`), so nothing is ever stripped. ~2M combinations per domain —
 * ample for the tiny live temp pool; the caller retries on the rare collision.
 */
import { randomInt } from "crypto";

const FIRST_NAMES = [
  "maria", "james", "olivia", "liam", "emma", "noah", "ava", "ethan", "sophia",
  "mason", "isabella", "logan", "mia", "lucas", "amelia", "jackson", "harper",
  "aiden", "evelyn", "elijah", "abigail", "grayson", "emily", "carter", "ella",
  "owen", "chloe", "wyatt", "grace", "julian", "lily", "leo", "nora", "hudson",
  "zoe", "ezra", "hazel", "miles", "aurora", "sawyer", "violet", "hunter",
  "clara", "adrian", "stella", "colin", "ruby", "marcus", "iris", "victor",
  "diana", "oscar", "naomi", "felix", "june", "simon", "eliza", "dean", "faye",
  "arthur", "nina", "roman", "tessa", "bruno", "leah", "gavin", "paige", "reid",
  "sadie", "cole", "willa", "brandon", "elena", "derek", "monica", "trevor",
  "helena", "warren", "greta", "isaac", "carmen", "philip", "rosa", "declan",
  "wren", "quentin", "beatrix", "sebastian", "delia", "malcolm", "cora",
];

const LAST_NAMES = [
  "holt", "reyes", "parker", "quinn", "shaw", "vance", "brooks", "cole", "dale",
  "flynn", "grant", "hayes", "irwin", "jenkins", "keller", "lowe", "marsh",
  "nolan", "oakes", "pratt", "rhodes", "sloan", "tate", "underwood", "voss",
  "walsh", "yates", "abbott", "boyd", "cross", "dunn", "ellis", "frost", "gates",
  "hardy", "ingram", "james", "knox", "lyons", "mercer", "nash", "ortega",
  "payne", "reeves", "sutton", "todd", "vaughn", "webb", "york", "avery",
  "bishop", "carr", "doyle", "everett", "finch", "gill", "hobbs", "iverson",
  "joyce", "kramer", "leach", "moss", "novak", "owens", "perry", "riggs",
  "stein", "tucker", "vega", "ward", "zimmer",
];

const ADJECTIVES = [
  "sunny", "quiet", "clever", "bright", "swift", "amber", "silver", "gentle",
  "brave", "calm", "lucky", "mellow", "nimble", "polar", "royal", "sage",
  "vivid", "witty", "cosmic", "dusky", "frosty", "golden", "hazy", "jolly",
  "keen", "lively", "misty", "noble", "olive", "plucky",
];

const NOUNS = [
  "fox", "lake", "pine", "hawk", "reef", "dune", "moss", "wren", "elm", "cove",
  "peak", "vale", "birch", "cedar", "otter", "heron", "maple", "raven", "sparrow",
  "willow", "cliff", "brook", "ember", "flint", "grove", "harbor", "meadow",
  "quartz", "ridge", "thorn",
];

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(arr.length)];
}

/** Two digits (10–99) so every handle ends in a stable, natural-looking suffix. */
function twoDigits(): number {
  return randomInt(10, 100);
}

/**
 * A single human-plausible local part, e.g. `maria.holt73`, `parker.reyes8`,
 * `sunnyfox42`. Never `tmp-*` or bare hex.
 */
export function generateTempLocalPart(): string {
  switch (randomInt(3)) {
    case 0:
      return `${pick(FIRST_NAMES)}.${pick(LAST_NAMES)}${twoDigits()}`;
    case 1:
      return `${pick(FIRST_NAMES)}${pick(LAST_NAMES)}${randomInt(1, 10)}`;
    default:
      return `${pick(ADJECTIVES)}${pick(NOUNS)}${twoDigits()}`;
  }
}
