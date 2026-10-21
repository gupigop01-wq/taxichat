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
});
