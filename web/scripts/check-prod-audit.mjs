import { spawnSync } from "node:child_process";

// Stable is a client-only BrowserRouter SPA. It does not use React Server
// Components, action endpoints, data routers, or server-side route execution.
// GHSA-qwww-vcr4-c8h2 applies to RSC action requests and currently has no
// published patched react-router release (the advisory says <8.3 while the
// registry's latest release is 7.x). Keep this one explicit waiver narrow and
// fail CI for every other production high/critical advisory.
const allowedAdvisories = new Set([1124282]);

const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
});
if (!audit.stdout) {
  console.error("npm audit produced no JSON output");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error("npm audit output was not valid JSON");
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};
const advisoryIdsFor = (name, seen = new Set()) => {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const item = vulnerabilities[name];
  const ids = new Set();
  for (const via of item?.via ?? []) {
    if (typeof via === "string") {
      for (const id of advisoryIdsFor(via, seen)) ids.add(id);
    } else if (typeof via?.source === "number") {
      ids.add(via.source);
    }
  }
  return ids;
};

const unexpected = [];
for (const [name, item] of Object.entries(vulnerabilities)) {
  if (!["high", "critical"].includes(item.severity)) continue;
  const ids = advisoryIdsFor(name);
  if (ids.size === 0 || [...ids].some((id) => !allowedAdvisories.has(id))) {
    unexpected.push({ name, severity: item.severity, advisoryIds: [...ids] });
  }
}

if (unexpected.length) {
  console.error("Unexpected production dependency advisories:");
  for (const item of unexpected) console.error(JSON.stringify(item));
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(
  `Production audit accepted: ${counts.critical ?? 0} critical, ` +
    `${counts.high ?? 0} high; only the documented RSC-only advisory is waived.`,
);
