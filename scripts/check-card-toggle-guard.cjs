// Runs the real JotDropView.toggleChecklist from src/view.ts against a synthetic
// in-memory vault: an own (bulk) color change must not block the next tick, while
// a real body change must never let a card index hit the wrong source line.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const esbuild = require("esbuild");

const viewPath = process.argv[2] || path.join(process.cwd(), "src/view.ts");

(async () => {
  const source = ts.createSourceFile("view.ts", fs.readFileSync(viewPath, "utf8"), ts.ScriptTarget.Latest, true);
  const cls = source.statements.find((n) => ts.isClassDeclaration(n) && n.name?.text === "JotDropView");
  const method = cls.members.find((n) => n.name?.getText(source) === "toggleChecklist");
  const compiled = ts.transpileModule(`class Probe {${method.getText(source)}}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const bundled = await esbuild.build({
    stdin: { contents: 'export { checklistBody, toggleChecklistItem } from "./src/metadata.ts";', resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{
      name: "obsidian-stub",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: 'export const getLanguage = () => "en";' }));
      },
    }],
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", bundled.outputFiles[0].text)(loaded, loaded.exports, require);
  const { checklistBody, toggleChecklistItem } = loaded.exports;
  let notices = [];
  const Probe = new Function("checklistBody", "toggleChecklistItem", "Notice", "t", `${compiled}; return Probe;`)(
    checklistBody, toggleChecklistItem, class { constructor(...args) { notices.push(args.join(" ")); } }, (...args) => args.join(":"),
  );

  const tasks = (n) => Array.from({ length: n }, (_, i) => `- [ ] task ${i + 1}`).join("\n");
  const toggleEl = () => {
    const strike = { classes: new Set(), toggleClass(c, on) { if (on) this.classes.add(c); else this.classes.delete(c); } };
    return { textContent: "☐", nextElementSibling: strike, setText(v) { this.textContent = v; }, setAttribute() {} };
  };
  const run = async (disk, index, expected, opts = {}) => {
    notices = [];
    let renders = 0;
    const probe = new Probe();
    const state = { disk };
    probe.app = { vault: { process: async (_file, fn) => { if (opts.fail) throw new Error("disk full"); state.disk = fn(state.disk); } } };
    probe.plugin = { suppressModifyOnce() {} };
    probe.render = () => { renders++; };
    const el = toggleEl();
    const updated = await probe.toggleChecklist({ path: "synthetic.md" }, index, el, expected);
    return { disk: state.disk, updated, renders, el, notices: [...notices] };
  };
  const fail = (msg, r) => { throw new Error(`${msg}: ${JSON.stringify({ notices: r.notices, renders: r.renders, disk: r.disk })}`); };

  const rendered = `---\ncolor: red\n---\n# List\n${tasks(10)}`;

  // Own card color change, then tick task 5 and task 10.
  for (const index of [4, 9]) {
    const disk = rendered.replace("color: red", "color: blue");
    const r = await run(disk, index, rendered);
    if (r.notices.length || r.renders) fail(`tick ${index + 1} after own color change was refused`, r);
    if (!r.disk.includes(`- [x] task ${index + 1}`)) fail(`task ${index + 1} not ticked`, r);
    if ((r.disk.match(/- \[x\]/g) || []).length !== 1) fail("more than one task changed", r);
    if (!r.disk.startsWith("---\ncolor: blue\n---\n")) fail("new color lost", r);
    if (r.updated !== r.disk || r.el.textContent !== "☑" || !r.el.nextElementSibling.classes.has("just-struck")) fail("card state not updated", r);
  }

  // Bulk color on a note that had no frontmatter yet, and a reset to default color.
  {
    const plain = `# List\n${tasks(10)}`;
    const r = await run(`---\ncolor: green\n---\n${plain}`, 9, plain);
    if (r.notices.length || !r.disk.endsWith("- [x] task 10") || !r.disk.startsWith("---\ncolor: green\n---\n")) fail("tick after bulk color (new frontmatter) failed", r);
    const back = await run(plain, 4, rendered);
    if (back.notices.length || !back.disk.includes("- [x] task 5")) fail("tick after color reset failed", back);
  }

  // Real external body changes stay refused and write nothing.
  const external = {
    "task inserted before": rendered.replace("# List\n", "# List\n- [ ] new first\n"),
    "task removed": rendered.replace("- [ ] task 1\n", ""),
    "task text edited": rendered.replace("task 5", "task five"),
    "task ticked elsewhere": rendered.replace("- [ ] task 3", "- [x] task 3"),
    "body and color changed": rendered.replace("color: red", "color: blue").replace("- [ ] task 1\n", ""),
  };
  for (const [name, disk] of Object.entries(external)) {
    const r = await run(disk, 9, rendered);
    if (r.disk !== disk) fail(`${name}: wrote despite a changed body`, r);
    if (r.notices.length !== 1 || !r.notices[0].includes("preview_changed") || r.renders !== 1) fail(`${name}: no refusal and fresh render`, r);
    if (r.updated !== undefined || r.el.textContent !== "☐") fail(`${name}: card claims a tick`, r);
  }

  // A YAML value that looks like a task is not a task; editing it does not block.
  {
    const yaml = `---\nnote: |\n  - [ ] not a task\n---\n${tasks(2)}`;
    const r = await run(yaml.replace("not a task", "still not"), 1, yaml);
    if (r.notices.length || !r.disk.endsWith("- [x] task 2") || !r.disk.includes("- [ ] still not")) fail("frontmatter checkbox changed or tick refused", r);
  }

  // Quick second click with the pre-first-click expectation: refused, never the wrong line.
  {
    const first = await run(rendered, 0, rendered);
    const second = await run(first.disk, 1, rendered);
    if (second.disk !== first.disk || second.notices.length !== 1 || second.renders !== 1) fail("stale quick click was not refused safely", second);
    const chained = await run(first.disk, 1, first.updated);
    if (chained.notices.length || !chained.disk.includes("- [x] task 1\n- [x] task 2\n- [ ] task 3")) fail("click with updated expectation failed", chained);
  }

  // A failed write shows an error, re-renders and leaves the card unticked.
  {
    const r = await run(rendered, 0, rendered, { fail: true });
    if (r.disk !== rendered || r.notices.length !== 1 || !r.notices[0].includes("disk full") || r.renders !== 1 || r.el.textContent !== "☐" || r.updated !== undefined) fail("write failure not handled safely", r);
  }

  console.log("card toggle guard checks passed");
})().catch((err) => { console.error(err.message || err); process.exit(1); });
