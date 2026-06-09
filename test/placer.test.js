const { test } = require("node:test");
const assert = require("node:assert");
const { slippageOk, pickButtonLabel } = require("../betting/placer");

test("slippage allows equal or better odds", () => {
  assert.equal(slippageOk(2.0, 2.0), true);
  assert.equal(slippageOk(2.0, 2.1), true); // better
});

test("slippage rejects a drop beyond tolerance", () => {
  assert.equal(slippageOk(2.0, 1.95, 0.03), true); // 2.5% drop ok
  assert.equal(slippageOk(2.0, 1.9, 0.03), false); // 5% drop rejected
  assert.equal(slippageOk(2.0, 0, 0.03), false); // invalid odd
});

test("pickButtonLabel finds first wanted label among page buttons", () => {
  const found = ["Войти", "Сделать ставку", "Очистить"];
  assert.equal(pickButtonLabel(found, ["Заключить пари", "Сделать ставку"]), "Сделать ставку");
});

test("pickButtonLabel is case/space-insensitive and substring", () => {
  const found = ["  ЗАКЛЮЧИТЬ ПАРИ  "];
  assert.equal(pickButtonLabel(found, ["Заключить пари"]), "  ЗАКЛЮЧИТЬ ПАРИ  ");
});

test("pickButtonLabel returns null when nothing matches", () => {
  assert.equal(pickButtonLabel(["Отмена"], ["Поставить"]), null);
});
