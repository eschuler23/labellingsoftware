import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];

type Project = {
  id: number;
  name: string;
  image_count: number;
  labeled_count: number;
  last_index: number;
};

type ImageItem = {
  rel_path: string;
  filename: string;
  label: string;
  url: string;
};

type ProjectResponse = {
  projects: Project[];
};

type ImagesResponse = {
  images: ImageItem[];
  last_index: number;
};

type LabelsResponse = {
  labels: string[];
};

const isSupported = (file: File) => {
  const lower = file.name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

const escapeCsv = (value: string) => {
  const escaped = value.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
};

const buildCsv = (items: ImageItem[]) => {
  const rows = items.filter((item) => item.label);
  const lines = [
    "filename,label",
    ...rows.map((row) => `${escapeCsv(row.rel_path)},${escapeCsv(row.label)}`),
  ];
  return lines.join("\n");
};

const downloadText = (filename: string, text: string) => {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const fetchJson = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const isForm = options?.body instanceof FormData;
  const headers = { ...(options?.headers || {}) } as Record<string, string>;
  if (!isForm) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || "Request failed");
  }

  return (await res.json()) as T;
};

const groupFilesByRoot = (files: File[]) => {
  const groups = new Map<string, File[]>();

  files.forEach((file) => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const path = relative && relative.length > 0 ? relative : file.name;
    const root = path.split("/")[0] || "Uploads";
    const list = groups.get(root) || [];
    list.push(file);
    groups.set(root, list);
  });

  return Array.from(groups.entries()).map(([name, list]) => ({ name, files: list }));
};

const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [labelOptions, setLabelOptions] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [newLabel, setNewLabel] = useState("");
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!fileInputRef.current) return;
    fileInputRef.current.setAttribute("webkitdirectory", "");
    fileInputRef.current.setAttribute("directory", "");
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const data = await fetchJson<ProjectResponse>("/api/projects");
      setProjects(data.projects);
      if (!selectedProjectId && data.projects.length > 0) {
        setSelectedProjectId(data.projects[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    }
  }, [selectedProjectId]);

  const updateProjectCounts = useCallback((projectId: number, nextImages: ImageItem[]) => {
    const labeled = nextImages.filter((item) => item.label).length;
    setProjects((prev) =>
      prev.map((project) =>
        project.id === projectId
          ? { ...project, image_count: nextImages.length, labeled_count: labeled }
          : project
      )
    );
  }, []);

  const loadProjectData = useCallback(
    async (projectId: number) => {
      setLoading(true);
      setError(null);
      try {
        const [imagesRes, labelsRes] = await Promise.all([
          fetchJson<ImagesResponse>(`/api/projects/${projectId}/images`),
          fetchJson<LabelsResponse>(`/api/projects/${projectId}/label-options`),
        ]);

        setImages(imagesRes.images);
        updateProjectCounts(projectId, imagesRes.images);
        setLabelOptions(labelsRes.labels);
        setEditingLabel(null);
        setEditValue("");
        const safeIndex = Math.min(imagesRes.last_index || 0, Math.max(imagesRes.images.length - 1, 0));
        setCurrentIndex(safeIndex);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load project");
      } finally {
        setLoading(false);
      }
    },
    [updateProjectCounts]
  );

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (selectedProjectId === null) return;
    loadProjectData(selectedProjectId);
  }, [loadProjectData, selectedProjectId]);

  useEffect(() => {
    if (currentIndex >= images.length) {
      setCurrentIndex(Math.max(images.length - 1, 0));
    }
  }, [currentIndex, images.length]);

  useEffect(() => {
    if (selectedProjectId === null) return;
    const handle = setTimeout(() => {
      fetchJson(`/api/projects/${selectedProjectId}/position`, {
        method: "POST",
        body: JSON.stringify({ index: currentIndex }),
      }).catch(() => undefined);
      setProjects((prev) =>
        prev.map((project) =>
          project.id === selectedProjectId ? { ...project, last_index: currentIndex } : project
        )
      );
    }, 400);

    return () => clearTimeout(handle);
  }, [currentIndex, selectedProjectId]);

  const refreshImages = useCallback(async () => {
    if (selectedProjectId === null) return;
    setLoading(true);
    try {
      await fetchJson(`/api/projects/${selectedProjectId}/rescan`, { method: "POST" });
      const imagesRes = await fetchJson<ImagesResponse>(
        `/api/projects/${selectedProjectId}/images`
      );
      setImages(imagesRes.images);
      updateProjectCounts(selectedProjectId, imagesRes.images);
      setCurrentIndex((prev) => Math.min(prev, Math.max(imagesRes.images.length - 1, 0)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh images");
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId, updateProjectCounts]);

  const handleFilesChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const list = event.target.files;
      if (!list) return;

      const files = Array.from(list).filter(isSupported);
      if (!files.length) {
        setError("No supported images found in that folder.");
        return;
      }

      const groups = groupFilesByRoot(files);
      setUploading(true);
      setError(null);

      const created: number[] = [];

      try {
        for (const group of groups) {
          const form = new FormData();
          form.append("project_name", group.name);
          group.files.forEach((file) => {
            const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
            const filename = relative && relative.length > 0 ? relative : file.name;
            form.append("files", file, filename);
          });

          const response = await fetchJson<{ project: Project }>("/api/projects/upload", {
            method: "POST",
            body: form,
          });
          created.push(response.project.id);
        }

        await loadProjects();
        if (created.length > 0) {
          setSelectedProjectId(created[created.length - 1]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
        event.target.value = "";
      }
    },
    [loadProjects]
  );

  const currentItem = images[currentIndex] || null;
  const currentLabel = currentItem?.label || "";

  const labeledCount = useMemo(() => images.filter((item) => item.label).length, [images]);

  const progressPercent = images.length
    ? Math.round((labeledCount / images.length) * 100)
    : 0;

  const applyLabel = useCallback(
    async (label: string) => {
      if (!currentItem || selectedProjectId === null) return;
      const relPath = currentItem.rel_path;
      const prevLabel = currentItem.label;

      try {
        await fetchJson(`/api/projects/${selectedProjectId}/labels`, {
          method: "POST",
          body: JSON.stringify({ rel_path: relPath, label }),
        });

        setImages((prev) =>
          prev.map((item, index) =>
            index === currentIndex ? { ...item, label } : item
          )
        );

        const nextImages = images.map((item, index) =>
          index === currentIndex ? { ...item, label } : item
        );
        updateProjectCounts(selectedProjectId, nextImages);

        if (currentIndex < images.length - 1) {
          setCurrentIndex((prev) => Math.min(prev + 1, images.length - 1));
        }

      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save label");
      }
    },
    [currentIndex, currentItem, images, selectedProjectId, updateProjectCounts]
  );

  const clearLabel = useCallback(async () => {
    if (!currentItem || selectedProjectId === null) return;
    try {
      await fetchJson(`/api/projects/${selectedProjectId}/labels`, {
        method: "POST",
        body: JSON.stringify({ rel_path: currentItem.rel_path, label: "" }),
      });

      setImages((prev) =>
        prev.map((item, index) =>
          index === currentIndex ? { ...item, label: "" } : item
        )
      );

      const nextImages = images.map((item, index) =>
        index === currentIndex ? { ...item, label: "" } : item
      );
      updateProjectCounts(selectedProjectId, nextImages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear label");
    }
  }, [currentIndex, currentItem, images, selectedProjectId, updateProjectCounts]);

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => Math.min(prev + 1, images.length - 1));
  }, [images.length]);

  const skip = useCallback(() => {
    if (currentIndex < images.length - 1) {
      setCurrentIndex((prev) => Math.min(prev + 1, images.length - 1));
    }
  }, [currentIndex, images.length]);

  const handleExport = useCallback(() => {
    if (!images.length) return;
    const csv = buildCsv(images);
    downloadText("labels.csv", csv);
  }, [images]);

  const handleAddLabel = useCallback(async () => {
    const label = newLabel.trim();
    if (!label || selectedProjectId === null) return;
    try {
      const response = await fetchJson<LabelsResponse>(
        `/api/projects/${selectedProjectId}/label-options`,
        {
          method: "POST",
          body: JSON.stringify({ name: label }),
        }
      );
      setLabelOptions(response.labels);
      setNewLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add label");
    }
  }, [newLabel, selectedProjectId]);

  const handleStartEdit = useCallback((label: string) => {
    setEditingLabel(label);
    setEditValue(label);
  }, []);

  const handleRenameLabel = useCallback(async () => {
    if (!editingLabel || selectedProjectId === null) return;
    const nextName = editValue.trim();
    if (!nextName) return;
    if (nextName === editingLabel) {
      setEditingLabel(null);
      setEditValue("");
      return;
    }
    try {
      const response = await fetchJson<LabelsResponse>(`/api/projects/${selectedProjectId}/label-options`, {
        method: "PATCH",
        body: JSON.stringify({ old_name: editingLabel, new_name: nextName }),
      });
      setLabelOptions(response.labels);
      setImages((prev) =>
        prev.map((item) =>
          item.label === editingLabel ? { ...item, label: nextName } : item
        )
      );
      const nextImages = images.map((item) =>
        item.label === editingLabel ? { ...item, label: nextName } : item
      );
      updateProjectCounts(selectedProjectId, nextImages);
      setEditingLabel(null);
      setEditValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename label");
    }
  }, [editValue, editingLabel, images, selectedProjectId, updateProjectCounts]);

  const handleDeleteLabel = useCallback(
    async (label: string) => {
      if (selectedProjectId === null) return;
      if (!window.confirm(`Delete label \"${label}\"? This will clear it from labeled images.`)) {
        return;
      }
      try {
        const response = await fetchJson<LabelsResponse>(`/api/projects/${selectedProjectId}/label-options`, {
          method: "DELETE",
          body: JSON.stringify({ name: label, delete_labels: true }),
        });
        setLabelOptions(response.labels);
        setImages((prev) =>
          prev.map((item) => (item.label === label ? { ...item, label: "" } : item))
        );
        const nextImages = images.map((item) =>
          item.label === label ? { ...item, label: "" } : item
        );
        updateProjectCounts(selectedProjectId, nextImages);
        if (editingLabel === label) {
          setEditingLabel(null);
          setEditValue("");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete label");
      }
    },
    [editingLabel, images, selectedProjectId, updateProjectCounts]
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrev();
      } else if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (labelOptions[index]) {
          event.preventDefault();
          applyLabel(labelOptions[index]);
        }
      } else if (event.key.toLowerCase() === "x") {
        if (currentLabel) {
          event.preventDefault();
          clearLabel();
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [applyLabel, clearLabel, currentLabel, goNext, goPrev, labelOptions]);

  const sidebarProjects = useMemo(() => {
    if (!projects.length) return null;
    return projects.map((project) => (
      <button
        key={project.id}
        className={`list-item ${project.id === selectedProjectId ? "active" : ""}`}
        onClick={() => setSelectedProjectId(project.id)}
        type="button"
      >
        <div className="list-name">{project.name}</div>
        <div className="project-meta">
          {project.labeled_count}/{project.image_count}
        </div>
      </button>
    ));
  }, [projects, selectedProjectId]);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="brand">Labeling Studio</div>
          <div className="subtle">Stateful image labeling with SQLite + uploads</div>
        </div>
        <div className="actions">
          <label className="btn primary file-button">
            {uploading ? "Uploading..." : "Upload Folder"}
            <input
              ref={fileInputRef}
              type="file"
              accept={SUPPORTED_EXTENSIONS.join(",")}
              multiple
              onChange={handleFilesChange}
              disabled={uploading}
            />
          </label>
          <button className="btn ghost" onClick={refreshImages} disabled={!selectedProjectId || loading} type="button">
            Refresh
          </button>
          <button className="btn ghost" onClick={handleExport} disabled={!labeledCount} type="button">
            Export CSV
          </button>
        </div>
      </header>

      <div className="content">
        <aside className="card sidebar">
          <div className="sidebar-header">
            <div>
              <div className="section-title">Projects</div>
              <div className="subtle">Upload multiple folders to create projects.</div>
            </div>
            <div className="stat">{projects.length}</div>
          </div>

          <div className="progress">
            <div className="progress-row">
              <span>
                {images.length ? `Image ${currentIndex + 1} of ${images.length}` : "No images"}
              </span>
              <span>{labeledCount} labeled</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>

          <div className="list">
            {projects.length ? (
              sidebarProjects
            ) : (
              <div className="empty-list">
                <div className="empty-icon">+</div>
                <div className="empty-title">Upload a folder to start</div>
                <div className="subtle">Each folder becomes a separate project.</div>
              </div>
            )}
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
        </aside>

        <main className="card viewer">
          {loading ? (
            <div className="empty-viewer">
              <div className="empty-title">Loading project...</div>
            </div>
          ) : currentItem ? (
            <>
              <div className="viewer-top">
                <div>
                  <div className="filename">{currentItem.rel_path}</div>
                  <div className="subtle">Use 1-9 for labels, arrows to navigate, X to clear.</div>
                </div>
                <div className={`pill ${currentLabel ? "pill-filled" : "pill-empty"}`}>
                  {currentLabel || "Unlabeled"}
                </div>
              </div>

              <div className="image-shell">
                <img src={currentItem.url} alt={currentItem.filename} />
              </div>

              <div className="label-row">
                {labelOptions.map((label, index) => (
                  <button
                    key={label}
                    type="button"
                    className={`label-button ${currentLabel === label ? "active" : ""}`}
                    onClick={() => applyLabel(label)}
                  >
                    <span>{label}</span>
                    <span className="keycap">{index + 1}</span>
                  </button>
                ))}
                <button className="btn ghost" onClick={clearLabel} disabled={!currentLabel} type="button">
                  Clear Label
                </button>
              </div>

              <div className="label-add">
                <input
                  className="label-input"
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.target.value)}
                  placeholder="Add a custom label"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleAddLabel();
                    }
                  }}
                />
                <button className="btn" onClick={handleAddLabel} disabled={!newLabel.trim()} type="button">
                  Add Label
                </button>
              </div>

              <div className="label-manage">
                <div className="section-title">Manage Labels</div>
                {labelOptions.map((label) => (
                  <div key={label} className="label-item">
                    {editingLabel === label ? (
                      <input
                        className="label-inline-input"
                        value={editValue}
                        onChange={(event) => setEditValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            handleRenameLabel();
                          }
                          if (event.key === "Escape") {
                            setEditingLabel(null);
                            setEditValue("");
                          }
                        }}
                      />
                    ) : (
                      <span className="label-name">{label}</span>
                    )}
                    <div className="label-actions">
                      {editingLabel === label ? (
                        <>
                          <button className="btn small" onClick={handleRenameLabel} type="button">
                            Save
                          </button>
                          <button
                            className="btn ghost small"
                            onClick={() => {
                              setEditingLabel(null);
                              setEditValue("");
                            }}
                            type="button"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn ghost small" onClick={() => handleStartEdit(label)} type="button">
                            Edit
                          </button>
                          <button className="btn ghost small" onClick={() => handleDeleteLabel(label)} type="button">
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="nav-row">
                <button className="btn" onClick={goPrev} disabled={currentIndex <= 0} type="button">
                  Prev
                </button>
                <button className="btn ghost" onClick={skip} disabled={currentIndex >= images.length - 1} type="button">
                  Skip
                </button>
                <button className="btn" onClick={goNext} disabled={currentIndex >= images.length - 1} type="button">
                  Next
                </button>
              </div>
            </>
          ) : (
            <div className="empty-viewer">
              <div className="empty-title">No images loaded</div>
              <div className="subtle">
                Upload a folder or pick a project from the sidebar to start labeling.
              </div>
              <div className="empty-hint">Tip: You can add custom labels anytime.</div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
