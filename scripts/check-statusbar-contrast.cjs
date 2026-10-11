const fs = require("fs");
const path = require("path");

const mainActivityPath = path.join(__dirname, "..", "android", "app", "src", "main", "kotlin", "com", "diexar", "keepcapture", "MainActivity.kt");
const source = fs.readFileSync(mainActivityPath, "utf8");

const errors = [];

function assert(condition, label) {
  if (!condition) {
    errors.push(label);
  }
}

// Must import Configuration for theme detection
assert(
  source.includes("import android.content.res.Configuration"),
  "Missing import android.content.res.Configuration"
);

// Must NOT use enableEdgeToEdge (doesn't control icon color)
assert(
  !source.includes("enableEdgeToEdge"),
  "Should not use enableEdgeToEdge (does not fix status bar icon contrast)"
);

// Must have the updateStatusBarAppearance method
assert(
  source.includes("private fun updateStatusBarAppearance()"),
  "Missing updateStatusBarAppearance() method"
);

// AndroidX handles old and new APIs without overwriting other system UI flags.
assert(
  source.includes("isAppearanceLightStatusBars = !isDark"),
  "Missing theme-aware status bar appearance"
);

// Must check for dark theme via Configuration UI_MODE_NIGHT_MASK
assert(
  source.includes("Configuration.UI_MODE_NIGHT_MASK"),
  "Missing Configuration.UI_MODE_NIGHT_MASK check"
);

// Must call updateStatusBarAppearance in onResume
const onResumeMatch = source.match(/override fun onResume\(\)[\s\S]*?\n    \}/);
assert(
  onResumeMatch && onResumeMatch[0].includes("updateStatusBarAppearance()"),
  "updateStatusBarAppearance() not called in onResume()"
);

// Must NOT have enableEdgeToEdge() call
assert(
  !source.includes("enableEdgeToEdge()"),
  "Should not call enableEdgeToEdge()"
);

if (errors.length > 0) {
  console.error("Regression check FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("Status bar contrast check PASSED: theme-aware icon color in MainActivity verified.");
