// Team-name matching across bookmakers (1xBet uses different spellings than Olimp).
// Extracted from the original server.js and hardened so it can be unit-tested.

const CYR_TO_LAT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ь: "", ы: "y", ъ: "", э: "e", ю: "yu", я: "ya",
};

// Words that carry no identity (club suffixes, age groups, gender, …). They are
// dropped before comparing so "Madura" matches "Madura Utd".
const STOP_TOKENS = new Set([
  "fc", "fk", "sc", "cd", "ac", "if", "sk", "city", "united", "utd", "club",
  "team", "sporting", "al", "el", "women", "woman", "ladies", "u17", "u18",
  "u19", "u20", "u21", "u23", "youth", "reserve", "reserves", "ii",
]);

function transliterate(text) {
  if (!text) return "";
  return text
    .toLowerCase()
    .split("")
    .map((ch) => (ch in CYR_TO_LAT ? CYR_TO_LAT[ch] : ch))
    .join("");
}

// Break a team name into comparable identity tokens.
function tokens(name) {
  if (!name) return [];
  const clean = transliterate(name).replace(/[^a-z0-9\s]/g, " ");
  return clean
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_TOKENS.has(w));
}

// Length of the shared leading prefix of two strings.
function commonPrefix(x, y) {
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x[i] === y[i]) i++;
  return i;
}

// Do two token sets share an identity word? Transliteration is imperfect
// (Челси→chelsi vs chelsea), so besides exact/prefix-contains we also accept a
// shared leading prefix of >= 4 chars, which bridges most spelling variants.
function overlap(a, b) {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
      if (commonPrefix(x, y) >= 4) return true;
    }
  }
  return false;
}

/**
 * Decide whether two events are the same fixture.
 * Returns { match: bool, reversed: bool } — reversed means home/away are swapped
 * between the two bookmakers, which the caller must mirror when pairing odds.
 */
function sameEvent(a, b) {
  const a1 = tokens(a.team1), a2 = tokens(a.team2);
  const b1 = tokens(b.team1), b2 = tokens(b.team2);
  if (!a1.length || !a2.length || !b1.length || !b2.length) return { match: false, reversed: false };

  if (overlap(a1, b1) && overlap(a2, b2)) return { match: true, reversed: false };
  if (overlap(a1, b2) && overlap(a2, b1)) return { match: true, reversed: true };
  return { match: false, reversed: false };
}

module.exports = { transliterate, tokens, overlap, sameEvent };
