import { gzipSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve("dist/.vite/manifest.json");

// These limits protect the normal app path while acknowledging that rich,
// opt-in renderers (Mermaid/CodeMirror) and LiveKit are intentionally heavier.
// Vite hashes filenames, so budgets are based on the manifest graph and stable
// chunk names rather than generated hashes.
const budgets = {
  initialRaw: 600 * 1024,
  initialGzip: 200 * 1024,
  defaultChunkRaw: 800 * 1024,
  defaultChunkGzip: 260 * 1024,
  exceptions: [
    {
      pattern: /(?:vendor-livekit|MermaidRenderer|wardley)/,
      raw: 1_250 * 1024,
      gzip: 400 * 1024,
    },
    {
      // Message code highlighting is already a user-triggered dynamic import.
      // highlight.js ships its complete language registry in this entry.
      pattern: /node_modules\/highlight\.js\/es\/index\.js/,
      raw: 1_050 * 1024,
      gzip: 340 * 1024,
    },
    {
      // three.js + @pixiv/three-vrm, reached ONLY through the lazy import in
      // AgentPresenceFace. Limits are the FIRST MEASURED size (706.3 KiB raw /
      // 181.3 KiB gzip on 2026-08-01, three 0.180 + three-vrm 3.5.5) plus ~15%
      // headroom — not a round number picked in advance. Tighter than the
      // default gzip ceiling on purpose: this chunk is big enough that it must
      // never grow quietly.
      pattern: /vendor-three-vrm/,
      raw: 815 * 1024,
      gzip: 209 * 1024,
    },
  ],
};

/**
 * Chunks that may only ever be reached through ONE named lazy boundary.
 *
 * This is the load-bearing half of the talking-face bundle contract, and it is
 * NOT the same question as "is it in the initial graph". `RoomView` is itself a
 * dynamic import, so a stray `import VrmAvatar from ...` in a shared module
 * leaves the entry graph untouched while quietly adding ~700 KiB to every user
 * who opens a room — with the feature flag off. Measured: doing exactly that
 * put `vendor-three-vrm` into the static imports of RoomView, KnowledgePanel
 * and ReactRenderer, and every size budget above still passed.
 *
 * So check the shape of the graph instead of its weight:
 *   1. the heavy chunk has exactly one static importer, the designated module;
 *   2. that module is only ever a DYNAMIC import target, never a static one.
 */
const lazyOnlyChunks = [
  {
    chunk: /vendor-three-vrm/,
    viaKey: "src/components/Agents/VrmAvatar.tsx",
    why: "three.js must stay behind the AgentPresenceFace lazy import — a user who never enables stable.talkingFace.v1 must not download it",
  },
];

function checkLazyOnly(manifest, failures) {
  for (const { chunk, viaKey, why } of lazyOnlyChunks) {
    const heavy = Object.entries(manifest).filter(([, r]) => chunk.test(r.file));
    if (!heavy.length) continue; // not built in this configuration
    const heavyKeys = new Set(heavy.map(([key]) => key));

    if (!manifest[viaKey]) {
      // The heavy chunk exists but its designated lazy module is not a chunk of
      // its own: the lazy() boundary has been replaced by a static import, so
      // the renderer has been folded into whatever imports it.
      failures.push(
        `${viaKey} is no longer a standalone chunk — its lazy() boundary is gone. ${why}`,
      );
      continue;
    }
    for (const [key, record] of Object.entries(manifest)) {
      if (key === viaKey) continue;
      const leaked = (record.imports ?? []).filter((i) => heavyKeys.has(i));
      if (leaked.length) {
        failures.push(
          `${record.file} STATICALLY imports ${leaked.join(", ")} — ${why}`,
        );
      }
      if ((record.imports ?? []).includes(viaKey)) {
        failures.push(
          `${record.file} STATICALLY imports ${viaKey} — it must only ever be lazy()'d. ${why}`,
        );
      }
    }
  }
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function assetSize(file) {
  const absolute = path.resolve("dist", file);
  const [metadata, contents] = await Promise.all([
    stat(absolute),
    readFile(absolute),
  ]);
  return { raw: metadata.size, gzip: gzipSync(contents).length };
}

function findEntry(manifest) {
  const entry = Object.values(manifest).find(
    (record) => record.isEntry && record.src === "index.html",
  );
  if (!entry) throw new Error("Bundle budget: index.html entry not found");
  return entry;
}

function initialFiles(manifest, entry) {
  const byFile = new Map(
    Object.values(manifest).map((record) => [record.file, record]),
  );
  const files = new Set();
  const visit = (record) => {
    if (!record || files.has(record.file)) return;
    files.add(record.file);
    for (const imported of record.imports ?? []) {
      visit(manifest[imported] ?? byFile.get(imported));
    }
  };
  visit(entry);
  return [...files].filter((file) => file.endsWith(".js"));
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = findEntry(manifest);
  const initial = initialFiles(manifest, entry);
  const initialSizes = await Promise.all(initial.map(assetSize));
  const initialRaw = initialSizes.reduce((total, size) => total + size.raw, 0);
  const initialGzip = initialSizes.reduce(
    (total, size) => total + size.gzip,
    0,
  );

  const failures = [];
  checkLazyOnly(manifest, failures);
  if (initialRaw > budgets.initialRaw) {
    failures.push(
      `initial JS raw ${format(initialRaw)} exceeds ${format(budgets.initialRaw)}`,
    );
  }
  if (initialGzip > budgets.initialGzip) {
    failures.push(
      `initial JS gzip ${format(initialGzip)} exceeds ${format(budgets.initialGzip)}`,
    );
  }

  const jsRecords = new Map();
  for (const [key, record] of Object.entries(manifest)) {
    if (record.file.endsWith(".js") && !jsRecords.has(record.file)) {
      jsRecords.set(record.file, { key, record });
    }
  }
  for (const [file, { key }] of jsRecords) {
    const size = await assetSize(file);
    const identity = `${key}:${file}`;
    const exception = budgets.exceptions.find(({ pattern }) =>
      pattern.test(identity),
    );
    const rawLimit = exception?.raw ?? budgets.defaultChunkRaw;
    const gzipLimit = exception?.gzip ?? budgets.defaultChunkGzip;
    if (size.raw > rawLimit || size.gzip > gzipLimit) {
      failures.push(
        `${file} is ${format(size.raw)} raw / ${format(size.gzip)} gzip ` +
          `(limits ${format(rawLimit)} / ${format(gzipLimit)})`,
      );
    }
  }

  console.log(
    `Bundle budget: initial JS ${format(initialRaw)} raw / ${format(initialGzip)} gzip across ${initial.length} files.`,
  );
  if (failures.length) {
    console.error("Bundle budget failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
