// DevPanel v2 — per-project file manager. Blobs are stored in SQLite; the latest
// version of a file is MAX(version). Used by both the REST API and the MCP tools.
//
// Download streams the blob in bounded chunks via substr() so JS never holds the
// whole file in memory (better-sqlite3 exposes no incremental blob API; substr
// caps each read to CHUNK bytes). Uploads buffer the body — per SPEC only the
// *download* path must stream.
import { db, logActivity } from "./db.js";
import { projectId } from "./store.js";

export type Folder = { id: number; project_id: number; parent_id: number | null; name: string };
export type FileRow = {
  id: number;
  project_id: number;
  folder_id: number | null;
  name: string;
  mime: string;
  size: number;
  created_at: string;
};
export type VersionRow = { id: number; version: number; size: number; created_at: string };

// ---- folders ----------------------------------------------------------------
export function listFolders(project: string): Folder[] {
  return db.prepare("SELECT * FROM folders WHERE project_id = ? ORDER BY name").all(projectId(project)) as Folder[];
}

export function createFolder(agent: string, a: { project: string; name: string; parent_id?: number | null }): number {
  const pid = projectId(a.project);
  if (a.parent_id != null && !db.prepare("SELECT 1 FROM folders WHERE id = ? AND project_id = ?").get(a.parent_id, pid))
    throw new Error("parent folder not in project");
  const id = Number(
    db.prepare("INSERT INTO folders (project_id, parent_id, name) VALUES (?, ?, ?)").run(pid, a.parent_id ?? null, a.name)
      .lastInsertRowid,
  );
  logActivity(agent, `create_folder #${id} "${a.name}" in ${a.project}`);
  return id;
}

export function deleteFolder(agent: string, id: number): void {
  if (!db.prepare("DELETE FROM folders WHERE id = ?").run(id).changes) throw new Error(`unknown folder: ${id}`);
  db.pragma("incremental_vacuum");
  logActivity(agent, `delete_folder #${id}`);
}

// ---- files ------------------------------------------------------------------
export function listFiles(project: string): FileRow[] {
  return db.prepare("SELECT * FROM files WHERE project_id = ? ORDER BY name").all(projectId(project)) as FileRow[];
}

export function getFile(id: number): FileRow | undefined {
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow | undefined;
}

// Create a file + its version 1. `data` is empty for a freshly created text file.
function storeNewFile(
  agent: string,
  a: { project: string; name: string; mime: string; folder_id?: number | null },
  data: Buffer,
  action: string,
): number {
  const pid = projectId(a.project);
  if (a.folder_id != null && !db.prepare("SELECT 1 FROM folders WHERE id = ? AND project_id = ?").get(a.folder_id, pid))
    throw new Error("folder not in project");
  const id = db.transaction(() => {
    const fid = Number(
      db
        .prepare("INSERT INTO files (project_id, folder_id, name, mime, size) VALUES (?, ?, ?, ?, ?)")
        .run(pid, a.folder_id ?? null, a.name, a.mime, data.length).lastInsertRowid,
    );
    db.prepare("INSERT INTO file_versions (file_id, version, blob) VALUES (?, 1, ?)").run(fid, data);
    return fid;
  })();
  logActivity(agent, `${action} #${id} "${a.name}" (${data.length}b) in ${a.project}`);
  return id;
}

export function createFile(agent: string, a: { project: string; name: string; mime: string; folder_id?: number | null }): number {
  return storeNewFile(agent, a, Buffer.alloc(0), "create_file");
}

export function uploadFile(
  agent: string,
  a: { project: string; name: string; mime: string; folder_id?: number | null; data: Buffer },
): number {
  return storeNewFile(agent, a, a.data, "upload_file");
}

export function deleteFile(agent: string, id: number): void {
  if (!db.prepare("DELETE FROM files WHERE id = ?").run(id).changes) throw new Error(`unknown file: ${id}`);
  db.pragma("incremental_vacuum");
  logActivity(agent, `delete_file #${id}`);
}

// New version = MAX(version)+1; keeps files.size in sync with the latest blob.
export function addVersion(agent: string, fileId: number, data: Buffer): number {
  if (!getFile(fileId)) throw new Error(`unknown file: ${fileId}`);
  const v = db.transaction(() => {
    const cur = (db.prepare("SELECT MAX(version) AS m FROM file_versions WHERE file_id = ?").get(fileId) as { m: number | null }).m ?? 0;
    const next = cur + 1;
    db.prepare("INSERT INTO file_versions (file_id, version, blob) VALUES (?, ?, ?)").run(fileId, next, data);
    db.prepare("UPDATE files SET size = ? WHERE id = ?").run(data.length, fileId);
    return next;
  })();
  logActivity(agent, `add_version #${fileId} v${v} (${data.length}b)`);
  return v;
}

export function listVersions(fileId: number): VersionRow[] {
  return db
    .prepare("SELECT id, version, length(blob) AS size, created_at FROM file_versions WHERE file_id = ? ORDER BY version DESC")
    .all(fileId) as VersionRow[];
}

// Restore = copy an old version's bytes forward as a brand-new version.
export function restoreVersion(agent: string, fileId: number, version: number): number {
  const src = db.prepare("SELECT blob FROM file_versions WHERE file_id = ? AND version = ?").get(fileId, version) as
    | { blob: Buffer | null }
    | undefined;
  if (!src) throw new Error(`no version ${version} for file ${fileId}`);
  const v = addVersion(agent, fileId, src.blob ?? Buffer.alloc(0));
  logActivity(agent, `restore_file #${fileId} v${version} → v${v}`);
  return v;
}

export function latestVersion(fileId: number): { id: number; size: number } | undefined {
  return db
    .prepare("SELECT id, length(blob) AS size FROM file_versions WHERE file_id = ? ORDER BY version DESC LIMIT 1")
    .get(fileId) as { id: number; size: number } | undefined;
}

// Stream a version's blob in CHUNK-sized pieces — bounded JS memory per read.
export function* readVersionChunks(versionId: number, size: number, chunk = 1 << 20): Generator<Buffer> {
  const stmt = db.prepare("SELECT substr(blob, ?, ?) AS c FROM file_versions WHERE id = ?");
  for (let off = 0; off < size; off += chunk) yield (stmt.get(off + 1, chunk, versionId) as { c: Buffer }).c;
}

// ---- MCP-safe reads: text only, capped, never secrets ----------------------
const TEXT_EXTRA = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "image/svg+xml",
]);
export function isTextMime(mime: string): boolean {
  return /^text\//.test(mime) || TEXT_EXTRA.has(mime) || mime.includes("markdown");
}
const MCP_MAX = 100 * 1024;

export function listFilesForMcp(project: string): { id: number; path: string; mime: string; size: number }[] {
  const pid = projectId(project);
  const folders = db.prepare("SELECT id, parent_id, name FROM folders WHERE project_id = ?").all(pid) as {
    id: number;
    parent_id: number | null;
    name: string;
  }[];
  const fmap = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (fid: number | null): string => {
    const parts: string[] = [];
    let cur = fid;
    while (cur != null) {
      const f = fmap.get(cur);
      if (!f) break;
      parts.unshift(f.name);
      cur = f.parent_id;
    }
    return parts.join("/");
  };
  return (
    db.prepare("SELECT id, folder_id, name, mime, size FROM files WHERE project_id = ? ORDER BY name").all(pid) as {
      id: number;
      folder_id: number | null;
      name: string;
      mime: string;
      size: number;
    }[]
  ).map((f) => {
    const dir = pathOf(f.folder_id);
    return { id: f.id, path: (dir ? dir + "/" : "") + f.name, mime: f.mime, size: f.size };
  });
}

export function readFileForMcp(fileId: number): { name: string; mime: string; size: number; content: string } {
  const f = getFile(fileId);
  if (!f) throw new Error(`unknown file: ${fileId}`);
  if (!isTextMime(f.mime)) throw new Error(`refusing non-text file (${f.mime})`);
  const v = latestVersion(fileId);
  const size = v?.size ?? 0;
  if (size > MCP_MAX) throw new Error(`file too large for read_file (${size}b > ${MCP_MAX}b)`);
  const row = db.prepare("SELECT blob FROM file_versions WHERE id = ?").get(v?.id) as { blob: Buffer | null } | undefined;
  return { name: f.name, mime: f.mime, size, content: (row?.blob ?? Buffer.alloc(0)).toString("utf8") };
}
