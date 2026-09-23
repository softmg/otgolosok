import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, inlineScriptHashes, withContentSecurityPolicy } from "../../scripts/content-security-policy.mjs";

const hash = (body: string) => `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
const policyOf = (html: string) => /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";

describe("content security policy", () => {
  it("разрешает только inline-скрипты страницы по их хешу", () => {
    const html = `<!DOCTYPE html><html><head><meta charSet="utf-8"/><script src="/_next/a.js" async=""></script></head>`
      + `<body><script>self.__next_f.push([1,"Привет"])</script><script id="x">(self.__next_f=[]).push(0)</script></body></html>`;
    const policy = policyOf(withContentSecurityPolicy(html));
    expect(policy).toContain(hash(`self.__next_f.push([1,"Привет"])`));
    expect(policy).toContain(hash("(self.__next_f=[]).push(0)"));
    expect(policy).not.toContain("'unsafe-inline' 'sha256");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(policy).toContain("object-src 'none'");
  });

  it("не хеширует внешние и пустые скрипты", () => {
    expect(inlineScriptHashes(`<script src="/a.js"></script><script async src='/b.js'></script><script></script>`)).toEqual([]);
    expect(contentSecurityPolicy([])).toMatch(/^default-src 'self'; script-src 'self'; /);
  });

  it("ставит политику до первого скрипта и не дублирует её при повторной сборке", () => {
    const html = `<html><head><meta charset="utf-8"><script>a()</script></head></html>`;
    const once = withContentSecurityPolicy(html);
    const twice = withContentSecurityPolicy(once);
    expect(twice).toBe(once);
    expect(once.indexOf("Content-Security-Policy")).toBeLessThan(once.indexOf("<script"));
  });

  it("использует <head>, если нет charset, и отказывает для страницы без head", () => {
    expect(withContentSecurityPolicy("<html><head><title>x</title></head></html>")).toMatch(/^<html><head><meta http-equiv="Content-Security-Policy"/);
    expect(() => withContentSecurityPolicy("<p>fragment</p>")).toThrow(/head/);
  });

  it("отказывает, если скрипт стоит раньше мест для политики", () => {
    expect(() => withContentSecurityPolicy(`<html><script>a()</script><head><meta charset="utf-8"></head></html>`)).toThrow(/before the first script/);
  });
});
