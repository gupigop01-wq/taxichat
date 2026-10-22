import sanitizeMessageHtml from "./sanitizeMessageHtml";

describe("sanitizeMessageHtml", () => {
  it("keeps text, line breaks and emoji images", () => {
    const html = 'Привет<br><div>мир <img class="w-[2.5rem]" src="https://cdn.example/e.png"></div>';
    expect(sanitizeMessageHtml(html)).toBe(html);
  });

  it("strips scripts, event handlers and javascript: urls", () => {
    const out = sanitizeMessageHtml(
      '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a><span onclick="a()">ok</span>'
    );
    expect(out).not.toMatch(/onerror|onclick|<script|<a |javascript:/i);
    expect(out).toContain("<span>ok</span>");
  });

  it("returns an empty string for non-strings", () => {
    expect(sanitizeMessageHtml(undefined)).toBe("");
  });

  it("preserves safe emoji and line breaks inside unsupported wrappers", () => {
    const safe = '<div>one<img class="emoji" src="https://cdn.example/e.png"></div><div>two<br><b>three</b></div>';
    expect(sanitizeMessageHtml(`<blockquote><font>${safe}</font></blockquote>`)).toBe(safe);
  });

  it("cleans descendants before unwrapping their parents", () => {
    const out = sanitizeMessageHtml(
      '<a href="javascript:alert(1)"><font><img src="javascript:alert(2)" onerror="alert(3)"><span onclick="alert(4)">safe<br>text</span></font></a>'
    );
    expect(out).toBe("<span>safe<br>text</span>");
  });

  it("keeps raw-text script contents inert after unwrapping", () => {
    const out = sanitizeMessageHtml('<script><img src="https://cdn.example/e.png" onerror="alert(1)"></script>');
    const container = document.createElement("div");
    container.innerHTML = out;
    expect(container.children).toHaveLength(0);
    expect(container.textContent).toContain("<img");
  });
});
