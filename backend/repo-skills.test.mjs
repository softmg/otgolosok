import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, ".agents/skills");
const adapters = join(root, ".claude/skills");
const names = directory => readdirSync(directory, {withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort();
test("Claude обнаруживает все канонические навыки через тонкие адаптеры", () => {
 assert.deepEqual(names(adapters), names(source));
 for (const name of names(source)) {
  const canonical = readFileSync(join(source,name,"SKILL.md"),"utf8");
  const file = join(adapters,name,"SKILL.md"), text = readFileSync(file,"utf8");
  const metadata = body => body.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1].replaceAll("\r", "");
  assert.equal(metadata(text),metadata(canonical), `frontmatter ${name}`);
  const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map(m=>resolve(dirname(file),m[1]));
  assert.deepEqual(links,[join(source,name,"SKILL.md")]);
  assert.ok(links.every(link=>existsSync(link)));
  assert.ok(text.length < 1800, `адаптер ${name} содержит копию процедуры`);
  const entries = readdirSync(join(adapters, name));
  assert.deepEqual(entries, ["SKILL.md"], `адаптер ${name} не должен дублировать скрипты, справочники или метаданные`);
 }
});
