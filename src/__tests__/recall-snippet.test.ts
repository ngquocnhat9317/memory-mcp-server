import assert from "node:assert/strict";
import test from "node:test";
import { buildMatchExcerpt, buildRecallSnippet, compactSnippetText, toRecallTerms } from "../utils.js";

const filler = "Background context sentence that does not mention the subject at all. ".repeat(6);

test("match inside the head returns exactly the old snippet", () => {
  const content = `Capybara habitat decision: keep the river site. ${filler}`;
  assert.equal(buildRecallSnippet(content, toRecallTerms("capybara habitat")), compactSnippetText(content));
});

test("match past 160 chars shows head, separator and the match within 160 chars", () => {
  const content = `Release review notes. ${filler} The axolotl migration was rejected because of cost. ${filler}`;
  const snippet = buildRecallSnippet(content, toRecallTerms("axolotl migration"));
  assert.ok(snippet.startsWith("Release review notes."), snippet);
  assert.ok(snippet.includes(" … "), snippet);
  assert.match(snippet, /axolotl/);
  assert.ok(snippet.length <= 160, `length ${snippet.length}`);
});

test("no literal match falls back to the old snippet", () => {
  const content = `Release review notes. ${filler}`;
  assert.equal(buildRecallSnippet(content, toRecallTerms("quokka")), compactSnippetText(content));
});

test("Vietnamese literal match gets a window", () => {
  const content = `Ghi chú họp. ${filler} Chủ dự án chọn cách tiếp cận thứ nhất. ${filler}`;
  const snippet = buildRecallSnippet(content, toRecallTerms("tiếp cận"));
  assert.match(snippet, /tiếp cận/);
  assert.ok(snippet.length <= 160);
});

test("a match only through diacritic folding falls back", () => {
  const content = `Ghi chú họp. ${filler} Chủ dự án chọn cách tiếp cận thứ nhất. ${filler}`;
  assert.equal(buildRecallSnippet(content, toRecallTerms("tiep can")), compactSnippetText(content));
});

test("whitespace and newlines are collapsed", () => {
  const content = `Line one.\n\n   ${filler}\n\tThe gecko\nfinding.  ${filler}`;
  const snippet = buildRecallSnippet(content, toRecallTerms("gecko finding"));
  assert.doesNotMatch(snippet, /\s{2,}|\n|\t/);
  assert.match(snippet, /gecko/);
});

test('a term containing a double quote is unescaped', () => {
  const content = `Intro. ${filler} We measured the say"hi" metric twice. ${filler}`;
  const snippet = buildRecallSnippet(content, toRecallTerms('say"hi"'));
  assert.match(snippet, /say"hi"/);
});

test("buildMatchExcerpt falls back to the head when no word matches literally", () => {
  const text = `Chung ta can tiếp tục kiem tra. ${filler}${filler}`;
  assert.ok(text.length > 300);
  const excerpt = buildMatchExcerpt(text, ["tiep"]);
  assert.equal(excerpt, `${text.replace(/\s+/g, " ").trim().slice(0, 157)}...`);
  assert.ok(excerpt.length <= 160);
});

test("buildMatchExcerpt centres a literal match within size", () => {
  const text = `${filler}${filler} The pelican finding was recorded here. ${filler}${filler}`;
  assert.ok(text.length > 300);
  const excerpt = buildMatchExcerpt(text, ["pelican"]);
  assert.match(excerpt, /pelican/);
  assert.ok(excerpt.length <= 160, `excerpt too long: ${excerpt.length}`);
  assert.ok(excerpt.startsWith("..."), excerpt);
});
