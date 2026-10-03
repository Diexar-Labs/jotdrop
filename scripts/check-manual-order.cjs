const esbuild = require("esbuild");

(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: 'export { RANK_SPACING, betweenRank, rankForManualOrder, respaceRanks } from "./src/manualOrder.ts";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });

  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  const { RANK_SPACING, betweenRank, rankForManualOrder, respaceRanks } = loaded.exports;

  if (rankForManualOrder(null, "2026-10-03 120000 New.md") !== -20261003120000) throw new Error("stamped fallback rank mismatch");
  if (rankForManualOrder(null, "Imported.md") !== 0) throw new Error("unstamped rank must not change on edit");
  if (rankForManualOrder(4, "Imported.md") !== 4) throw new Error("explicit rank mismatch");

  // Empty bucket → first card gets rank 0.
  if (betweenRank(null, null) !== 0) throw new Error("empty bucket rank mismatch");

  // Top insertion sits one spacing below the first neighbor.
  if (betweenRank(null, RANK_SPACING) !== 0) throw new Error("top insertion rank mismatch");

  // Bottom insertion sits one spacing above the last neighbor.
  if (betweenRank(0, null) !== RANK_SPACING) throw new Error("bottom insertion rank mismatch");

  // Middle insertion is the exact midpoint.
  if (betweenRank(0, RANK_SPACING) !== RANK_SPACING / 2) throw new Error("midpoint rank mismatch");

  // Midpoint must be strictly between its neighbors.
  const mid = betweenRank(10, 20);
  if (!(mid > 10 && mid < 20)) throw new Error("midpoint not strictly between");

  // Exhausted float gap (adjacent doubles) reports no room.
  const a = 1;
  const b = a + Number.EPSILON; // next representable double after 1
  if (betweenRank(a, b) !== null) throw new Error("exhausted gap should return null");

  // Respace produces evenly spaced ascending ranks.
  const expected = [1000, 1000 + RANK_SPACING, 1000 + 2 * RANK_SPACING, 1000 + 3 * RANK_SPACING];
  const ranks = respaceRanks(4, 1000);
  if (ranks.join(",") !== expected.join(",")) throw new Error("respace ranks mismatch");

  console.log("Manual order checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
