const fs = require("fs");
const path = require("path");

const cssPath = path.join(__dirname, "..", "styles.css");
const css = fs.readFileSync(cssPath, "utf8");

const errors = [];

function assertHasRule(selector, requiredProps) {
  // Find the exact CSS selector (not a substring of another selector like
  // ".jotdrop-card" inside ".jotdrop-card-select-marker").
  // The selector must be preceded by start-of-string, whitespace, or ">",
  // and followed by whitespace, "{", or ",".
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[\\s>])${escaped}(?=[\\s,\\{])`);
  const match = css.match(pattern);
  if (!match) {
    errors.push(`Rule ${selector} not found in styles.css`);
    return;
  }
  const selectorIdx = match.index + (match[0].startsWith(" ") || match[0].startsWith(">") ? 1 : 0);
  // Find the opening brace after the selector.
  let braceIdx = css.indexOf("{", selectorIdx);
  if (braceIdx < 0) {
    errors.push(`Rule ${selector} has no opening brace`);
    return;
  }
  // Find the matching closing brace (simple brace counting).
  let depth = 1;
  let endIdx = braceIdx + 1;
  while (depth > 0 && endIdx < css.length) {
    if (css[endIdx] === "{") depth++;
    else if (css[endIdx] === "}") depth--;
    endIdx++;
  }
  const body = css.slice(braceIdx + 1, endIdx - 1);
  for (const prop of requiredProps) {
    if (!body.includes(prop)) {
      errors.push(`Rule ${selector} missing property: ${prop}`);
    }
  }
}

// Keep the toolbar at the scrollport edge; clipping the toolbar itself cannot
// hide sibling cards painted into Obsidian's inherited top padding.
assertHasRule(".jotdrop-toolbar", [
  "position: sticky",
  "top: 0",
  "z-index: 10",
  "flex-shrink: 0",
]);

// Cards must keep content-visibility: auto for performance (not removed).
assertHasRule(".jotdrop-card", ["content-visibility: auto"]);

// View must remain the scroll container.
assertHasRule('.workspace-leaf-content[data-type="jotdrop-view"] > .view-content.jotdrop-view', [
  "overflow-y: auto", "height: 100%", "padding: 0 20px 32px",
]);

// Selection/tag filter visibility toggles must be preserved (combined selector).
assertHasRule(".jotdrop-toolbar.is-hidden", ["display: none"]);
assertHasRule(".jotdrop-filter-bar.is-hidden", ["display: none"]);

// Desktop/mobile card action visibility must be preserved (inside media query).
const mediaMatch = css.match(/@media \(max-width: 480px\)\s*\{([^}]*)\}/);
if (!mediaMatch) {
  errors.push("@media (max-width: 480px) not found in styles.css");
} else if (!mediaMatch[1].includes(".jotdrop-card-actions")) {
  errors.push("@media (max-width: 480px) missing .jotdrop-card-actions rule");
}

if (errors.length > 0) {
  console.error("Regression check FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("Regression check PASSED: toolbar containment, card visibility, and filter styles verified.");
