const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const mockObsidianPath = path.join(__dirname, "mock-obsidian.cjs");

(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: [
        `export { discoverLabels, createLabel, renameLabel, deleteLabel, assignLabel, removeLabel } from "./src/labelManager.ts";`,
        `export { readMeta, applyLabels, updateMeta } from "./src/metadata.ts";`,
      ].join("\n"),
      resolveDir: ROOT,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { obsidian: mockObsidianPath },
  });

  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { discoverLabels, createLabel, renameLabel, deleteLabel, assignLabel, removeLabel, readMeta, applyLabels } = loaded.exports;

  // --- Mock helpers ---
  function makeFile(filePath, frontmatter) {
    return { path: filePath, basename: filePath.split("/").pop(), stat: { ctime: 0, mtime: 0 }, frontmatter: frontmatter || {} };
  }

  function makeApp(files, cacheOverride) {
    const fileMap = new Map();
    for (const f of files) fileMap.set(f.path, f);
    return {
      metadataCache: {
        getFileCache: (file) => {
          const f = fileMap.get(file.path);
          if (!f) return null;
          if (cacheOverride && cacheOverride[file.path]) return cacheOverride[file.path];
          return { frontmatter: f.frontmatter };
        },
      },
      vault: {
        getMarkdownFiles: () => files.map((f) => ({ path: f.path, basename: f.basename, stat: f.stat })),
        getAbstractFileByPath: (p) => fileMap.get(p) || null,
      },
      fileManager: {
        processFrontMatter: async (file, fn) => {
          const f = fileMap.get(file.path);
          if (!f) throw new Error("File not found: " + file.path);
          fn(f.frontmatter);
        },
      },
    };
  }

  // --- Test 1: readMeta reads array labels ---
  {
    const app = makeApp([makeFile("Mini Notes/test.md", { jotdrop_labels: ["Work", "Personal"] })]);
    const file = { path: "Mini Notes/test.md", basename: "test.md", stat: { ctime: 0, mtime: 0 } };
    const meta = readMeta(app, file);
    if (meta.labels.length !== 2 || meta.labels[0] !== "Work" || meta.labels[1] !== "Personal") {
      throw new Error("Test 1 failed: array labels not read correctly");
    }
  }

  // --- Test 2: readMeta reads scalar label as single ---
  {
    const app = makeApp([makeFile("Mini Notes/test.md", { jotdrop_labels: "Work, Projects" })]);
    const file = { path: "Mini Notes/test.md", basename: "test.md", stat: { ctime: 0, mtime: 0 } };
    const meta = readMeta(app, file);
    if (meta.labels.length !== 1 || meta.labels[0] !== "Work, Projects") {
      throw new Error("Test 2 failed: scalar label should be single entry");
    }
  }

  // --- Test 3: readMeta rejects blank labels ---
  {
    const app = makeApp([makeFile("Mini Notes/test.md", { jotdrop_labels: ["Valid", "", "  "] })]);
    const file = { path: "Mini Notes/test.md", basename: "test.md", stat: { ctime: 0, mtime: 0 } };
    const meta = readMeta(app, file);
    if (meta.labels.length !== 1 || meta.labels[0] !== "Valid") {
      throw new Error("Test 3 failed: blank labels should be filtered");
    }
  }

  // --- Test 4: createLabel validates name ---
  {
    const app = makeApp([]);
    const r = await createLabel(app, "", "Mini Notes", "Mini Notes/Archive", []);
    if (r.success) throw new Error("Test 4a failed: empty name should fail");
    const r2 = await createLabel(app, "Good", "Mini Notes", "Mini Notes/Archive", []);
    if (!r2.success || !r2.labels?.includes("Good")) throw new Error("Test 4b failed: valid name should succeed");
  }

  // --- Test 5: createLabel rejects control characters ---
  {
    const app = makeApp([]);
    const r = await createLabel(app, "Bad\x00Name", "Mini Notes", "Mini Notes/Archive", []);
    if (r.success) throw new Error("Test 5 failed: control char should fail");
  }

  // --- Test 6: createLabel collision check ---
  {
    const app = makeApp([makeFile("Mini Notes/a.md", { jotdrop_labels: ["Existing"] })]);
    const r = await createLabel(app, "Existing", "Mini Notes", "Mini Notes/Archive", []);
    if (r.success) throw new Error("Test 6 failed: duplicate should fail");
  }

  // --- Test 7: discoverLabels finds labels in archive, not elsewhere ---
  {
    const app = makeApp([
      makeFile("Mini Notes/a.md", { jotdrop_labels: ["Work"] }),
      makeFile("Mini Notes/Archive/b.md", { jotdrop_labels: ["Personal"] }),
      makeFile("Other/c.md", { jotdrop_labels: ["Hidden"] }),
    ]);
    const labels = await discoverLabels(app, "Mini Notes", "Mini Notes/Archive");
    const names = labels.map((l) => l.name);
    if (names.includes("Hidden")) throw new Error("Test 7 failed: should not discover outside managed folders");
    if (!names.includes("Work") || !names.includes("Personal")) throw new Error("Test 7 failed: missing managed labels");
  }

  // --- Test 8: assignLabel uses fresh frontmatter ---
  {
    const fm = { jotdrop_labels: ["A"] };
    const file = makeFile("Mini Notes/x.md", fm);
    const app = makeApp([file]);
    await assignLabel(app, file, "B");
    if (!fm.jotdrop_labels?.includes("B")) throw new Error("Test 8a failed: label not added");
    if (fm.jotdrop_labels?.length !== 2) throw new Error("Test 8b failed: expected 2 labels, got " + fm.jotdrop_labels?.length);
  }

  // --- Test 9: applyLabels preserves other fields ---
  {
    const fm = { jotdrop_labels: ["Old"], color: "red", tags: ["tag1"] };
    const file = makeFile("Mini Notes/y.md", fm);
    const app = makeApp([file]);
    await applyLabels(app, file, ["New"]);
    if (fm.jotdrop_labels?.[0] !== "New") throw new Error("Test 9a failed: labels not replaced");
    if (fm.color !== "red") throw new Error("Test 9b failed: color not preserved");
    if (fm.tags?.[0] !== "tag1") throw new Error("Test 9c failed: tags not preserved");
  }

  // --- Test 10: renameLabel updates all managed files ---
  {
    const app = makeApp([
      makeFile("Mini Notes/a.md", { jotdrop_labels: ["Old"] }),
      makeFile("Mini Notes/Archive/b.md", { jotdrop_labels: ["Old", "Other"] }),
    ]);
    const r = await renameLabel(app, "Old", "New", "Mini Notes", "Mini Notes/Archive");
    if (!r.success || r.updated !== 2) throw new Error("Test 10 failed: expected 2 updates, got " + r.updated);
    const a = readMeta(app, { path: "Mini Notes/a.md", basename: "a.md", stat: { ctime: 0, mtime: 0 } });
    const b = readMeta(app, { path: "Mini Notes/Archive/b.md", basename: "b.md", stat: { ctime: 0, mtime: 0 } });
    if (!a.labels.includes("New") || a.labels.includes("Old")) throw new Error("Test 10a failed");
    if (!b.labels.includes("New") || b.labels.includes("Old")) throw new Error("Test 10b failed");
    if (!b.labels.includes("Other")) throw new Error("Test 10c failed: Other label lost");
  }

  // --- Test 11: deleteLabel removes from all managed files ---
  {
    const app = makeApp([
      makeFile("Mini Notes/a.md", { jotdrop_labels: ["Kill", "Keep"] }),
      makeFile("Mini Notes/Archive/b.md", { jotdrop_labels: ["Kill"] }),
    ]);
    const r = await deleteLabel(app, "Kill", "Mini Notes", "Mini Notes/Archive");
    if (!r.success || r.removed !== 2) throw new Error("Test 11 failed: expected 2 removals");
    const a = readMeta(app, { path: "Mini Notes/a.md", basename: "a.md", stat: { ctime: 0, mtime: 0 } });
    if (a.labels.includes("Kill") || !a.labels.includes("Keep")) throw new Error("Test 11a failed");
  }

  // --- Test 12: rename with invalid new name fails ---
  {
    const app = makeApp([makeFile("Mini Notes/a.md", { jotdrop_labels: ["X"] })]);
    const r = await renameLabel(app, "X", "", "Mini Notes", "Mini Notes/Archive");
    if (r.success) throw new Error("Test 12 failed: empty new name should fail");
  }

  // --- Test 13: label with spaces and punctuation preserved ---
  {
    const app = makeApp([makeFile("Mini Notes/a.md", { jotdrop_labels: [] })]);
    const r = await createLabel(app, "Work projects, 2026", "Mini Notes", "Mini Notes/Archive", []);
    if (!r.success || !r.labels?.includes("Work projects, 2026")) throw new Error("Test 13 failed");
  }

  // --- Test 14: assignLabel validates name ---
  {
    const app = makeApp([makeFile("Mini Notes/a.md", { jotdrop_labels: [] })]);
    const file = { path: "Mini Notes/a.md", basename: "a.md", stat: { ctime: 0, mtime: 0 } };
    let threw = false;
    try { await assignLabel(app, file, ""); } catch { threw = true; }
    if (!threw) throw new Error("Test 14 failed: assignLabel should reject blank");
  }

  // --- Test 15: discoverLabels dedupes across files ---
  {
    const app = makeApp([
      makeFile("Mini Notes/a.md", { jotdrop_labels: ["Shared"] }),
      makeFile("Mini Notes/b.md", { jotdrop_labels: ["Shared", "Unique"] }),
    ]);
    const labels = await discoverLabels(app, "Mini Notes", "Mini Notes/Archive");
    const shared = labels.find((l) => l.name === "Shared");
    if (!shared || shared.count !== 2) throw new Error("Test 15 failed: Shared count should be 2");
    const unique = labels.find((l) => l.name === "Unique");
    if (!unique || unique.count !== 1) throw new Error("Test 15 failed: Unique count should be 1");
  }

  // --- Test 16: removeLabel validates name ---
  {
    const app = makeApp([makeFile("Mini Notes/a.md", { jotdrop_labels: ["A"] })]);
    const file = { path: "Mini Notes/a.md", basename: "a.md", stat: { ctime: 0, mtime: 0 } };
    let threw = false;
    try { await removeLabel(app, file, ""); } catch { threw = true; }
    if (!threw) throw new Error("Test 16 failed: removeLabel should reject blank");
  }

  // --- Test 17: stale cache regression ---
  // metadataCache returns ['A'] but live processFrontMatter sees ['A','Concurrent'].
  // assignLabel/removeLabel/rename must preserve Concurrent.
  {
    const liveFm = { jotdrop_labels: ["A", "Concurrent"] };
    const staleCache = { frontmatter: { jotdrop_labels: ["A"] } };
    const file = makeFile("Mini Notes/x.md", liveFm);
    const app = makeApp([file], { "Mini Notes/x.md": staleCache });
    const getLive = () => file.frontmatter.jotdrop_labels;

    await assignLabel(app, file, "New");
    const afterAssign = getLive();
    if (!afterAssign.includes("Concurrent")) throw new Error("Test 17a failed: Concurrent lost on assign");
    if (!afterAssign.includes("New")) throw new Error("Test 17b failed: New not added");
    if (afterAssign.length !== 3) throw new Error("Test 17c failed: expected 3 labels, got " + afterAssign.length);

    await removeLabel(app, file, "New");
    const afterRemove = getLive();
    if (afterRemove.includes("New")) throw new Error("Test 17d failed: New not removed");
    if (!afterRemove.includes("Concurrent")) throw new Error("Test 17e failed: Concurrent lost on remove");

    await renameLabel(app, "A", "Renamed", "Mini Notes", "Mini Notes/Archive");
    const afterRename = getLive();
    if (afterRename.includes("A")) throw new Error("Test 17f failed: A still present");
    if (!afterRename.includes("Renamed")) throw new Error("Test 17g failed: Renamed missing");
    if (!afterRename.includes("Concurrent")) throw new Error("Test 17h failed: Concurrent lost on rename");
  }

  // --- Test 18: case-insensitive assign/remove/rename/delete ---
  {
    const app = makeApp([makeFile("Mini Notes/c.md", { jotdrop_labels: ["Work"] })]);
    const file = { path: "Mini Notes/c.md", basename: "c.md", stat: { ctime: 0, mtime: 0 } };

    // assign "work" when "Work" exists — no-op
    await assignLabel(app, file, "work");
    let meta = readMeta(app, file);
    if (meta.labels.length !== 1 || meta.labels[0] !== "Work") throw new Error("Test 18a failed: case-insensitive assign");

    // remove "WORK" removes "Work"
    await removeLabel(app, file, "WORK");
    meta = readMeta(app, file);
    if (meta.labels.length !== 0) throw new Error("Test 18b failed: case-insensitive remove");

    // recreate with "Work"
    await assignLabel(app, file, "Work");

    // rename "work" -> "Study" renames "Work"
    await renameLabel(app, "work", "Study", "Mini Notes", "Mini Notes/Archive");
    meta = readMeta(app, file);
    if (!meta.labels.includes("Study")) throw new Error("Test 18c failed: case-insensitive rename");
    if (meta.labels.includes("Work")) throw new Error("Test 18d failed: old case variant still present");

    // delete "STUDY" removes it
    await deleteLabel(app, "STUDY", "Mini Notes", "Mini Notes/Archive");
    meta = readMeta(app, file);
    if (meta.labels.length !== 0) throw new Error("Test 18e failed: case-insensitive delete");
  }

  // --- Test 19: case-insensitive create collision ---
  {
    const app = makeApp([makeFile("Mini Notes/d.md", { jotdrop_labels: ["Work"] })]);
    const r = await createLabel(app, "work", "Mini Notes", "Mini Notes/Archive", []);
    if (r.success) throw new Error("Test 19 failed: case-insensitive collision not detected");
  }

  // --- Test 20: case-insensitive discover dedup ---
  {
    const app = makeApp([
      makeFile("Mini Notes/a.md", { jotdrop_labels: ["Work"] }),
      makeFile("Mini Notes/b.md", { jotdrop_labels: ["work"] }),
    ]);
    const labels = await discoverLabels(app, "Mini Notes", "Mini Notes/Archive");
    const work = labels.find((l) => l.name.toLowerCase() === "work");
    if (!work) throw new Error("Test 20a failed: work label not found");
    if (work.count !== 2) throw new Error("Test 20b failed: expected count 2, got " + work.count);
    if (labels.length !== 1) throw new Error("Test 20c failed: expected 1 canonical label");
  }

  // --- Test 21: Trash exclusion from grid (isUnder logic) ---
  {
    const isUnder = (filePath, folderPath) => {
      if (!folderPath) return false;
      const f = folderPath.replace(/\/+$/, "");
      return filePath === f || filePath.startsWith(`${f}/`);
    };
    // Trash is under notesFolder (would be included without explicit exclusion)
    if (!isUnder("Mini Notes/Trash/file.md", "Mini Notes")) throw new Error("Test 21a failed");
    // Explicit Trash path exclusion check
    const trashPath = "Mini Notes/Trash";
    if (!isUnder("Mini Notes/Trash/file.md", trashPath)) throw new Error("Test 21b failed");
    // Archive Trash is NOT excluded by notesFolder Trash check
    if (isUnder("Archive/Trash/file.md", "Mini Notes/Trash")) throw new Error("Test 21c failed");
    // Non-Trash files under notesFolder are still under it
    if (!isUnder("Mini Notes/note.md", "Mini Notes")) throw new Error("Test 21d failed");
  }

  // Scalar memberships are valid shared metadata. Editing another collection must not erase them.
  {
    const fm = { jotdrop_labels: "Work, projects", tags: ["keep-tag"], custom: "keep" };
    const file = makeFile("Mini Notes/scalar.md", fm);
    const app = makeApp([file]);
    const unrelated = await deleteLabel(app, "Other", "Mini Notes", "Mini Notes/Archive");
    if (unrelated.removed !== 0 || fm.jotdrop_labels !== "Work, projects") throw new Error("Unrelated delete changed a scalar label");
    const unchanged = await renameLabel(app, "Other", "New", "Mini Notes", "Mini Notes/Archive");
    if (unchanged.updated !== 0) throw new Error("Rename counts unrelated notes");
    await assignLabel(app, file, "Second");
    if (readMeta(app, file).labels.join("|") !== "Work, projects|Second") throw new Error("Assign lost scalar membership");
    await removeLabel(app, file, "second");
    if (readMeta(app, file).labels.join("|") !== "Work, projects") throw new Error("Remove lost other membership");
    await renameLabel(app, "WORK, PROJECTS", "Renamed", "Mini Notes", "Mini Notes/Archive");
    if (readMeta(app, file).labels.join("|") !== "Renamed") throw new Error("Scalar rename failed");
    if (fm.tags.join("|") !== "keep-tag" || fm.custom !== "keep") throw new Error("Label mutation touched other metadata");
  }
  {
    const file = makeFile("Mini Notes/case.md", { jotdrop_labels: [" Work ", "work", "", "#Project"] });
    const meta = readMeta(makeApp([file]), file);
    if (meta.labels.join("|") !== "Work|#Project") throw new Error("Label normalization differs from Android");
  }

  console.log("Plugin label checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
