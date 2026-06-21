import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = process.argv.slice(2).map((entry) => path.resolve(repoRoot, entry));

if (roots.length === 0) {
  roots.push(path.join(repoRoot, "src-tauri", "target"));
  roots.push(path.join(process.env.TMPDIR || "/tmp", "bd-spinex-tauri-target"));
}

let removed = 0;

async function removeAppleDoubleFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.name.startsWith("._")) {
      await rm(fullPath, { force: true, recursive: true });
      removed += 1;
      return;
    }
    if (entry.isDirectory()) {
      await removeAppleDoubleFiles(fullPath);
    }
  }));
}

await Promise.all(roots.map(removeAppleDoubleFiles));

if (removed > 0) {
  console.log(`Removed ${removed} AppleDouble file${removed === 1 ? "" : "s"}.`);
}
