const { test } = require("node:test");
const assert = require("node:assert");
const { transliterate, tokens, sameEvent } = require("../lib/match");

test("transliteration of cyrillic", () => {
  assert.equal(transliterate("Барселона"), "barselona");
  assert.equal(transliterate("Реал"), "real");
});

test("tokens drop noise words and short tokens", () => {
  assert.deepEqual(tokens("Manchester United FC"), ["manchester"]); // utd/fc dropped
  assert.deepEqual(tokens("Реал Мадрид"), ["real", "madrid"]); // both kept; matched via overlap
});

test("same event direct match across languages", () => {
  const a = { team1: "Манчестер Сити", team2: "Реал Мадрид" };
  const b = { team1: "Manchester City", team2: "Real Madrid" };
  const r = sameEvent(a, b);
  assert.equal(r.match, true);
  assert.equal(r.reversed, false);
});

test("same event detects reversed home/away", () => {
  const a = { team1: "Ливерпуль", team2: "Челси" };
  const b = { team1: "Chelsea", team2: "Liverpool" };
  const r = sameEvent(a, b);
  assert.equal(r.match, true);
  assert.equal(r.reversed, true);
});

test("prefix match (Madura vs Madura Utd)", () => {
  const r = sameEvent(
    { team1: "Madura Utd", team2: "Persija" },
    { team1: "Madura", team2: "Persija Jakarta" }
  );
  assert.equal(r.match, true);
});

test("different events do not match", () => {
  const r = sameEvent(
    { team1: "Бавария", team2: "Дортмунд" },
    { team1: "Arsenal", team2: "Chelsea" }
  );
  assert.equal(r.match, false);
});
