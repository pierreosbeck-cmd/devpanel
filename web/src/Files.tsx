import { useEffect, useMemo, useRef, useState } from "react";
import { api, type FileMeta, type FileVersion, type Folder, type Project } from "./api";
import { useLoader } from "./App";

const isText = (mime: string) => /^text\//.test(mime) || /json|xml|yaml|toml|markdown|javascript|svg/.test(mime);

export function Files({ project, projects }: { project?: string; projects: Project[] }) {
  const [nonce, setNonce] = useState(0);
  const refresh = () => setNonce((n) => n + 1);
  const [folders] = useLoader<Folder[]>(() => (project ? api.folders(project) : Promise.resolve([])), [project, nonce]);
  const [files] = useLoader<FileMeta[]>(() => (project ? api.files(project) : Promise.resolve([])), [project, nonce]);
  const [selId, setSelId] = useState<number | null>(null);
  const [selFolder, setSelFolder] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const sel = (files ?? []).find((f) => f.id === selId) ?? null;
  useEffect(() => {
    if (selId && !(files ?? []).some((f) => f.id === selId)) setSelId(null);
  }, [files, selId]);

  const depth = useMemo(() => {
    const map = new Map((folders ?? []).map((f) => [f.id, f]));
    const d = (id: number | null): number => {
      let n = 0,
        cur = id;
      while (cur != null) {
        const f = map.get(cur);
        if (!f) break;
        cur = f.parent_id;
        n++;
      }
      return n;
    };
    return d;
  }, [folders]);

  if (!project)
    return (
      <div className="panel">
        <h2>Files</h2>
        <div className="muted">
          Välj ett projekt i toppbaren — filträdet visar det aktiva projektets filer.
          {projects.length === 0 && " (Inga projekt ännu.)"}
        </div>
      </div>
    );

  const newFolder = async () => {
    const name = prompt("Folder name:");
    if (!name) return;
    await api.createFolder({ project, name, parent_id: selFolder });
    refresh();
  };
  const newFile = async (ext: string) => {
    const name = prompt(`New .${ext} file name:`, `untitled.${ext}`);
    if (!name) return;
    const { id } = await api.createFileItem({
      project,
      name,
      mime: ext === "md" ? "text/markdown" : "text/plain",
      folder_id: selFolder,
    });
    refresh();
    setSelId(id);
  };
  const upload = async (fl: FileList | null) => {
    if (!fl?.length) return;
    for (const f of Array.from(fl)) await api.uploadFile(project, f, selFolder);
    refresh();
  };
  const del = async (kind: "file" | "folder", id: number) => {
    if (!confirm(`Delete this ${kind}?`)) return;
    if (kind === "file") await api.deleteFile(id);
    else await api.deleteFolder(id);
    refresh();
  };

  const filesIn = (fid: number | null) => (files ?? []).filter((f) => f.folder_id === fid);

  return (
    <div className="filer">
      <div className="panel">
        <div className="row-inline" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{project} / files</h2>
        </div>
        <div className="row-inline" style={{ marginBottom: 10 }}>
          <button className="ghost" onClick={newFolder} title="New folder in selected">
            📁+
          </button>
          <button className="ghost" onClick={() => newFile("txt")}>
            .txt
          </button>
          <button className="ghost" onClick={() => newFile("md")}>
            .md
          </button>
          <button className="ghost" onClick={() => fileInput.current?.click()}>
            ⬆ Upload
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        </div>

        <div className="tree">
          <div
            className={`node ${selFolder === null ? "sel" : ""}`}
            onClick={() => setSelFolder(null)}
            title="root"
          >
            <span>▸</span> /
          </div>
          {filesIn(null).map((f) => (
            <FileNode key={f.id} f={f} depth={1} sel={selId === f.id} onSel={() => setSelId(f.id)} onDel={() => del("file", f.id)} />
          ))}
          {(folders ?? []).map((fo) => (
            <div key={fo.id}>
              <div
                className={`node ${selFolder === fo.id ? "sel" : ""}`}
                style={{ paddingLeft: 8 + depth(fo.id) * 12 }}
                onClick={() => setSelFolder(fo.id)}
              >
                <span>📁</span>
                {fo.name}
                <button className="del clock" onClick={(e) => (e.stopPropagation(), del("folder", fo.id))}>
                  ✕
                </button>
              </div>
              {filesIn(fo.id).map((f) => (
                <FileNode
                  key={f.id}
                  f={f}
                  depth={depth(fo.id) + 1}
                  sel={selId === f.id}
                  onSel={() => setSelId(f.id)}
                  onDel={() => del("file", f.id)}
                />
              ))}
            </div>
          ))}
        </div>

        <div
          className={`dropzone ${drag ? "drag" : ""}`}
          onDragOver={(e) => (e.preventDefault(), setDrag(true))}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            upload(e.dataTransfer.files);
          }}
        >
          drop files here to upload {selFolder ? "(into selected folder)" : "(into root)"}
        </div>
      </div>

      <div className="panel">
        {sel ? <Editor file={sel} onChanged={refresh} onDeleted={() => (setSelId(null), refresh())} /> : (
          <div className="muted">Välj en fil för att visa/redigera.</div>
        )}
      </div>
    </div>
  );
}

function FileNode({
  f,
  depth,
  sel,
  onSel,
  onDel,
}: {
  f: FileMeta;
  depth: number;
  sel: boolean;
  onSel: () => void;
  onDel: () => void;
}) {
  return (
    <div className={`node ${sel ? "sel" : ""}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={onSel}>
      <span>{isText(f.mime) ? "📄" : "▦"}</span>
      {f.name}
      <span className="sz">{f.size}b</span>
      <button className="del clock" onClick={(e) => (e.stopPropagation(), onDel())}>
        ✕
      </button>
    </div>
  );
}

function Editor({ file, onChanged, onDeleted }: { file: FileMeta; onChanged: () => void; onDeleted: () => void }) {
  const text = isText(file.mime);
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [busy, setBusy] = useState(false);

  const loadVersions = () => api.fileVersions(file.id).then(setVersions).catch(() => {});
  useEffect(() => {
    setLoaded(false);
    loadVersions();
    if (text) api.readFileText(file.id).then((t) => (setContent(t), setLoaded(true))).catch(() => setLoaded(true));
    else setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  const save = async () => {
    setBusy(true);
    try {
      await api.saveFileVersion(file.id, content);
      await loadVersions();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const restore = async (v: string) => {
    if (!v) return;
    await api.restoreVersion(file.id, Number(v));
    await loadVersions();
    if (text) setContent(await api.readFileText(file.id));
    onChanged();
  };

  return (
    <div className="editor">
      <div className="row-inline" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <b>{file.name}</b> <span className="muted">{file.mime} · {file.size}b</span>
        </div>
        <div className="row-inline">
          <select defaultValue="" onChange={(e) => restore(e.target.value)} title="Restore version">
            <option value="">history…</option>
            {versions.map((v) => (
              <option key={v.id} value={v.version}>
                v{v.version} · {v.size}b
              </option>
            ))}
          </select>
          <a className="ghost" href={api.fileContentUrl(file.id)} download={file.name}>
            <button className="ghost">⬇ Download</button>
          </a>
          <button onClick={onDeleted} title="Delete file">
            🗑
          </button>
        </div>
      </div>
      {text ? (
        <>
          {!loaded ? (
            <div className="muted">Loading…</div>
          ) : (
            <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
          )}
          <div className="row-inline" style={{ marginTop: 8, justifyContent: "flex-end" }}>
            <span className="muted" style={{ marginRight: "auto" }}>
              Save creates a new version
            </span>
            <button className="primary" disabled={busy || !loaded} onClick={save}>
              Save version
            </button>
          </div>
        </>
      ) : (
        <div className="muted">
          Binary file ({file.mime}). Use Download to fetch it. {versions.length} version(s).
        </div>
      )}
    </div>
  );
}
