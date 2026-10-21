// Legacy chat messages are stored as HTML from a contentEditable input
// (text, line breaks and emoji <img>). Render only that safe subset: unknown
// tags are unwrapped to text, every attribute except img src/class is dropped.
const ALLOWED_TAGS = new Set(["BR", "DIV", "P", "SPAN", "B", "I", "STRONG", "EM", "IMG"]);
const SAFE_SRC = /^(https?:\/\/|\/(?!\/)|data:image\/(png|gif|jpe?g|webp);)/i;

const cleanNode = (node, doc) => {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) continue; // text
    if (child.nodeType !== 1) {
      child.remove();
      continue;
    }

    if (!ALLOWED_TAGS.has(child.tagName)) {
      child.replaceWith(doc.createTextNode(child.textContent ?? ""));
      continue;
    }

    for (const attr of Array.from(child.attributes)) {
      const keep =
        attr.name === "class" ||
        (child.tagName === "IMG" && attr.name === "src" && SAFE_SRC.test(attr.value.trim()));
      if (!keep) child.removeAttribute(attr.name);
    }
    if (child.tagName === "IMG" && !child.getAttribute("src")) {
      child.remove();
      continue;
    }

    cleanNode(child, doc);
  }
};

export default function sanitizeMessageHtml(html) {
  if (typeof html !== "string" || !html) return "";
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  cleanNode(doc.body, doc);
  return doc.body.innerHTML;
}
