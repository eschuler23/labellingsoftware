import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];

type Project = {
  id: number;
  name: string;
  image_count: number;
  labeled_count: number;
  last_index: number;
};

type LabelOption = {
  id: number;
  name: string;
  category_id: number;
};

type LabelCategory = {
  id: number;
  name: string;
  labels: LabelOption[];
};

type ImageLabel = {
  category_id: number;
  label_option_id: number;
  label_name: string;
};

type ImageItem = {
  rel_path: string;
  filename: string;
  url: string;
  labels: Record<number, ImageLabel>;
};

type ProjectResponse = {
  projects: Project[];
};

type ImagesResponse = {
  images: Array<{
    rel_path: string;
    filename: string;
    url: string;
    labels: ImageLabel[];
  }>;
  last_index: number;
};

type LabelSchemaResponse = {
  categories: LabelCategory[];
};

const isSupported = (file: File) => {
  const lower = file.name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

const escapeCsv = (value: string) => {
  const escaped = value.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
};

const buildCsv = (
  items: ImageItem[],
  categories: LabelCategory[],
  selectedLabelIds: Set<number>,
  onlySelected: boolean
) => {
  const exportCategories = categories.filter((category) =>
    category.labels.some((label) => selectedLabelIds.has(label.id))
  );

  const filteredItems = onlySelected
    ? items.filter((item) =>
        Object.values(item.labels).some((label) =>
          selectedLabelIds.has(label.label_option_id)
        )
      )
    : items;

  const header = [
    "filename",
    ...exportCategories.map((category) => category.name),
  ];
  const rows = filteredItems.map((item) => {
    const values = exportCategories.map((category) => {
      const label = item.labels[category.id];
      if (!label) return "";
      return selectedLabelIds.has(label.label_option_id)
        ? label.label_name
        : "";
    });
    return [item.rel_path, ...values].map(escapeCsv).join(",");
  });

  return [header.map(escapeCsv).join(","), ...rows].join("\n");
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

const fetchJson = async <T,>(
  url: string,
  options?: RequestInit
): Promise<T> => {
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
    const relative = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    const path = relative && relative.length > 0 ? relative : file.name;
    const root = path.split("/")[0] || "Uploads";
    const list = groups.get(root) || [];
    list.push(file);
    groups.set(root, list);
  });

  return Array.from(groups.entries()).map(([name, list]) => ({
    name,
    files: list,
  }));
};

const normalizeImages = (items: ImagesResponse["images"]): ImageItem[] => {
  return items.map((item) => {
    const labels: Record<number, ImageLabel> = {};
    item.labels.forEach((label) => {
      labels[label.category_id] = label;
    });
    return {
      rel_path: item.rel_path,
      filename: item.filename,
      url: item.url,
      labels,
    };
  });
};

const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(
    null
  );
  const [images, setImages] = useState<ImageItem[]>([]);
  const [categories, setCategories] = useState<LabelCategory[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [newCategory, setNewCategory] = useState("");
  const [newLabelByCategory, setNewLabelByCategory] = useState<
    Record<number, string>
  >({});
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(
    null
  );
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [editingLabelId, setEditingLabelId] = useState<number | null>(null);
  const [editingLabelName, setEditingLabelName] = useState("");
  const [selectedLabelIds, setSelectedLabelIds] = useState<Set<number>>(
    new Set()
  );
  const [exportOnlySelected, setExportOnlySelected] = useState(false);
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [filterMode, setFilterMode] = useState<"any" | "all">("any");
  const [filterLabelIds, setFilterLabelIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!fileInputRef.current) return;
    fileInputRef.current.setAttribute("webkitdirectory", "");
    fileInputRef.current.setAttribute("directory", "");
  }, []);

  const labelById = useMemo(() => {
    const map = new Map<number, LabelOption>();
    categories.forEach((category) => {
      category.labels.forEach((label) => {
        map.set(label.id, label);
      });
    });
    return map;
  }, [categories]);

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

  const updateProjectCounts = useCallback(
    (projectId: number, nextImages: ImageItem[]) => {
      const labeled = nextImages.filter(
        (item) => Object.keys(item.labels).length > 0
      ).length;
      setProjects((prev) =>
        prev.map((project) =>
          project.id === projectId
            ? {
                ...project,
                image_count: nextImages.length,
                labeled_count: labeled,
              }
            : project
        )
      );
    },
    []
  );

  const loadProjectData = useCallback(
    async (projectId: number) => {
      setLoading(true);
      setError(null);
      try {
        const [imagesRes, schemaRes] = await Promise.all([
          fetchJson<ImagesResponse>(`/api/projects/${projectId}/images`),
          fetchJson<LabelSchemaResponse>(
            `/api/projects/${projectId}/label-schema`
          ),
        ]);

        const normalized = normalizeImages(imagesRes.images);
        setImages(normalized);
        updateProjectCounts(projectId, normalized);
        setCategories(schemaRes.categories);
        const safeIndex = Math.min(
          imagesRes.last_index || 0,
          Math.max(normalized.length - 1, 0)
        );
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
          project.id === selectedProjectId
            ? { ...project, last_index: currentIndex }
            : project
        )
      );
    }, 400);

    return () => clearTimeout(handle);
  }, [currentIndex, selectedProjectId]);

  useEffect(() => {
    if (!categories.length) {
      setActiveCategoryId(null);
      return;
    }
    if (
      activeCategoryId === null ||
      !categories.some((c) => c.id === activeCategoryId)
    ) {
      setActiveCategoryId(categories[0].id);
    }

    const availableLabelIds = new Set<number>();
    categories.forEach((category) => {
      category.labels.forEach((label) => availableLabelIds.add(label.id));
    });

    setSelectedLabelIds((prev) => {
      const next = new Set<number>(prev);
      availableLabelIds.forEach((id) => next.add(id));
      for (const id of Array.from(next)) {
        if (!availableLabelIds.has(id)) {
          next.delete(id);
        }
      }
      if (next.size === 0) {
        availableLabelIds.forEach((id) => next.add(id));
      }
      return next;
    });

    setFilterLabelIds((prev) => {
      const next = new Set<number>();
      prev.forEach((id) => {
        if (availableLabelIds.has(id)) {
          next.add(id);
        }
      });
      return next;
    });

    setImages((prev) =>
      prev.map((item) => {
        const nextLabels: Record<number, ImageLabel> = {};
        Object.values(item.labels).forEach((label) => {
          const labelInfo = labelById.get(label.label_option_id);
          if (labelInfo) {
            nextLabels[label.category_id] = {
              category_id: label.category_id,
              label_option_id: label.label_option_id,
              label_name: labelInfo.name,
            };
          }
        });
        return { ...item, labels: nextLabels };
      })
    );
  }, [activeCategoryId, categories, labelById]);

  const refreshImages = useCallback(async () => {
    if (selectedProjectId === null) return;
    setLoading(true);
    try {
      await fetchJson(`/api/projects/${selectedProjectId}/rescan`, {
        method: "POST",
      });
      const imagesRes = await fetchJson<ImagesResponse>(
        `/api/projects/${selectedProjectId}/images`
      );
      const normalized = normalizeImages(imagesRes.images);
      setImages(normalized);
      updateProjectCounts(selectedProjectId, normalized);
      setCurrentIndex((prev) =>
        Math.min(prev, Math.max(normalized.length - 1, 0))
      );
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
            const relative = (file as File & { webkitRelativePath?: string })
              .webkitRelativePath;
            const filename =
              relative && relative.length > 0 ? relative : file.name;
            form.append("files", file, filename);
          });

          const response = await fetchJson<{ project: Project }>(
            "/api/projects/upload",
            {
              method: "POST",
              body: form,
            }
          );
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
  const currentLabel = (categoryId: number) =>
    currentItem?.labels[categoryId]?.label_name || "";

  const labeledCount = useMemo(
    () => images.filter((item) => Object.keys(item.labels).length > 0).length,
    [images]
  );

  const progressPercent = images.length
    ? Math.round((labeledCount / images.length) * 100)
    : 0;

  const filteredIndexes = useMemo(() => {
    if (!images.length) return [] as number[];
    if (!filterEnabled || filterLabelIds.size === 0) {
      return images.map((_, index) => index);
    }
    const selected = Array.from(filterLabelIds);
    return images
      .map((item, index) => {
        const itemLabels = Object.values(item.labels).map(
          (label) => label.label_option_id
        );
        if (filterMode === "all") {
          return selected.every((id) => itemLabels.includes(id)) ? index : -1;
        }
        return selected.some((id) => itemLabels.includes(id)) ? index : -1;
      })
      .filter((index) => index >= 0);
  }, [filterEnabled, filterLabelIds, filterMode, images]);

  useEffect(() => {
    if (!filteredIndexes.length) {
      if (images.length) {
        setCurrentIndex(0);
      }
      return;
    }
    if (!filteredIndexes.includes(currentIndex)) {
      setCurrentIndex(filteredIndexes[0]);
    }
  }, [currentIndex, filteredIndexes, images.length]);

  const applyLabel = useCallback(
    async (categoryId: number, labelOptionId: number) => {
      if (!currentItem || selectedProjectId === null) return;
      const relPath = currentItem.rel_path;
      try {
        await fetchJson(`/api/projects/${selectedProjectId}/labels`, {
          method: "POST",
          body: JSON.stringify({
            rel_path: relPath,
            category_id: categoryId,
            label_option_id: labelOptionId,
          }),
        });

        const labelInfo = labelById.get(labelOptionId);
        if (!labelInfo) return;
        const nextLabel: ImageLabel = {
          category_id: categoryId,
          label_option_id: labelOptionId,
          label_name: labelInfo.name,
        };

        setImages((prev) =>
          prev.map((item, index) =>
            index === currentIndex
              ? { ...item, labels: { ...item.labels, [categoryId]: nextLabel } }
              : item
          )
        );

        const nextImages = images.map((item, index) =>
          index === currentIndex
            ? { ...item, labels: { ...item.labels, [categoryId]: nextLabel } }
            : item
        );
        updateProjectCounts(selectedProjectId, nextImages);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save label");
      }
    },
    [
      currentIndex,
      currentItem,
      images,
      labelById,
      selectedProjectId,
      updateProjectCounts,
    ]
  );

  const clearLabel = useCallback(
    async (categoryId: number) => {
      if (!currentItem || selectedProjectId === null) return;
      try {
        await fetchJson(`/api/projects/${selectedProjectId}/labels`, {
          method: "POST",
          body: JSON.stringify({
            rel_path: currentItem.rel_path,
            category_id: categoryId,
            label_option_id: null,
          }),
        });

        setImages((prev) =>
          prev.map((item, index) => {
            if (index !== currentIndex) return item;
            const nextLabels = { ...item.labels };
            delete nextLabels[categoryId];
            return { ...item, labels: nextLabels };
          })
        );

        const nextImages = images.map((item, index) => {
          if (index !== currentIndex) return item;
          const nextLabels = { ...item.labels };
          delete nextLabels[categoryId];
          return { ...item, labels: nextLabels };
        });
        updateProjectCounts(selectedProjectId, nextImages);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to clear label");
      }
    },
    [currentIndex, currentItem, images, selectedProjectId, updateProjectCounts]
  );

  const handleAddCategory = useCallback(async () => {
    const name = newCategory.trim();
    if (!name || selectedProjectId === null) return;
    try {
      const response = await fetchJson<LabelSchemaResponse>(
        `/api/projects/${selectedProjectId}/label-categories`,
        {
          method: "POST",
          body: JSON.stringify({ name }),
        }
      );
      setCategories(response.categories);
      setNewCategory("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add category");
    }
  }, [newCategory, selectedProjectId]);

  const handleRenameCategory = useCallback(async () => {
    if (editingCategoryId === null || selectedProjectId === null) return;
    const name = editingCategoryName.trim();
    if (!name) return;
    try {
      const response = await fetchJson<LabelSchemaResponse>(
        `/api/projects/${selectedProjectId}/label-categories`,
        {
          method: "PATCH",
          body: JSON.stringify({ category_id: editingCategoryId, name }),
        }
      );
      setCategories(response.categories);
      setEditingCategoryId(null);
      setEditingCategoryName("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to rename category"
      );
    }
  }, [editingCategoryId, editingCategoryName, selectedProjectId]);

  const handleDeleteCategory = useCallback(
    async (categoryId: number) => {
      if (selectedProjectId === null) return;
      if (!window.confirm("Delete this category and all its labels?")) return;
      try {
        const response = await fetchJson<LabelSchemaResponse>(
          `/api/projects/${selectedProjectId}/label-categories`,
          {
            method: "DELETE",
            body: JSON.stringify({ category_id: categoryId }),
          }
        );
        setCategories(response.categories);
        setImages((prev) =>
          prev.map((item) => {
            const nextLabels = { ...item.labels };
            delete nextLabels[categoryId];
            return { ...item, labels: nextLabels };
          })
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to delete category"
        );
      }
    },
    [selectedProjectId]
  );

  const handleAddLabel = useCallback(
    async (categoryId: number) => {
      if (selectedProjectId === null) return;
      const name = (newLabelByCategory[categoryId] || "").trim();
      if (!name) return;
      try {
        const response = await fetchJson<LabelSchemaResponse>(
          `/api/projects/${selectedProjectId}/label-options`,
          {
            method: "POST",
            body: JSON.stringify({ category_id: categoryId, name }),
          }
        );
        setCategories(response.categories);
        setNewLabelByCategory((prev) => ({ ...prev, [categoryId]: "" }));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add label");
      }
    },
    [newLabelByCategory, selectedProjectId]
  );

  const handleRenameLabel = useCallback(async () => {
    if (editingLabelId === null || selectedProjectId === null) return;
    const name = editingLabelName.trim();
    if (!name) return;
    try {
      const response = await fetchJson<LabelSchemaResponse>(
        `/api/projects/${selectedProjectId}/label-options`,
        {
          method: "PATCH",
          body: JSON.stringify({ label_id: editingLabelId, name }),
        }
      );
      setCategories(response.categories);
      setEditingLabelId(null);
      setEditingLabelName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename label");
    }
  }, [editingLabelId, editingLabelName, selectedProjectId]);

  const handleDeleteLabel = useCallback(
    async (labelId: number) => {
      if (selectedProjectId === null) return;
      if (!window.confirm("Delete this label and clear it from images?"))
        return;
      try {
        const response = await fetchJson<LabelSchemaResponse>(
          `/api/projects/${selectedProjectId}/label-options`,
          {
            method: "DELETE",
            body: JSON.stringify({ label_id: labelId }),
          }
        );
        setCategories(response.categories);
        setImages((prev) =>
          prev.map((item) => {
            const nextLabels = { ...item.labels };
            Object.values(nextLabels).forEach((label) => {
              if (label.label_option_id === labelId) {
                delete nextLabels[label.category_id];
              }
            });
            return { ...item, labels: nextLabels };
          })
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete label");
      }
    },
    [selectedProjectId]
  );

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => {
      if (!filteredIndexes.length) {
        return Math.max(prev - 1, 0);
      }
      const position = filteredIndexes.indexOf(prev);
      if (position <= 0) {
        return filteredIndexes[0];
      }
      return filteredIndexes[position - 1];
    });
  }, [filteredIndexes]);

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => {
      if (!filteredIndexes.length) {
        return Math.min(prev + 1, images.length - 1);
      }
      const position = filteredIndexes.indexOf(prev);
      if (position === -1) {
        return filteredIndexes[0];
      }
      const nextIndex = Math.min(position + 1, filteredIndexes.length - 1);
      return filteredIndexes[nextIndex];
    });
  }, [filteredIndexes, images.length]);

  const skip = useCallback(() => {
    if (!filteredIndexes.length) {
      if (currentIndex < images.length - 1) {
        setCurrentIndex((prev) => Math.min(prev + 1, images.length - 1));
      }
      return;
    }
    const position = filteredIndexes.indexOf(currentIndex);
    if (position >= 0 && position < filteredIndexes.length - 1) {
      setCurrentIndex(filteredIndexes[position + 1]);
    }
  }, [currentIndex, filteredIndexes, images.length]);

  const handleExport = useCallback(() => {
    if (!images.length) return;
    const csv = buildCsv(
      images,
      categories,
      selectedLabelIds,
      exportOnlySelected
    );
    downloadText("labels.csv", csv);
  }, [categories, exportOnlySelected, images, selectedLabelIds]);

  const toggleLabelSelection = useCallback((labelId: number) => {
    setSelectedLabelIds((prev) => {
      const next = new Set(prev);
      if (next.has(labelId)) {
        next.delete(labelId);
      } else {
        next.add(labelId);
      }
      return next;
    });
  }, []);

  const selectAllLabels = useCallback(() => {
    const all = new Set<number>();
    categories.forEach((category) =>
      category.labels.forEach((label) => all.add(label.id))
    );
    setSelectedLabelIds(all);
  }, [categories]);

  const clearAllLabels = useCallback(() => {
    setSelectedLabelIds(new Set());
  }, []);

  const toggleFilterLabel = useCallback((labelId: number) => {
    setFilterLabelIds((prev) => {
      const next = new Set(prev);
      if (next.has(labelId)) {
        next.delete(labelId);
      } else {
        next.add(labelId);
      }
      return next;
    });
  }, []);

  const clearFilterLabels = useCallback(() => {
    setFilterLabelIds(new Set());
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrev();
      } else if (/^[1-9]$/.test(event.key)) {
        if (!activeCategoryId) return;
        const category = categories.find((c) => c.id === activeCategoryId);
        if (!category) return;
        const index = Number(event.key) - 1;
        if (category.labels[index]) {
          event.preventDefault();
          applyLabel(activeCategoryId, category.labels[index].id);
        }
      } else if (event.key.toLowerCase() === "x") {
        if (activeCategoryId && currentLabel(activeCategoryId)) {
          event.preventDefault();
          clearLabel(activeCategoryId);
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeCategoryId,
    applyLabel,
    categories,
    clearLabel,
    currentLabel,
    goNext,
    goPrev,
  ]);

  const sidebarProjects = useMemo(() => {
    if (!projects.length) return null;
    return projects.map((project) => (
      <button
        key={project.id}
        className={`list-item ${
          project.id === selectedProjectId ? "active" : ""
        }`}
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

  const labelCounts = useMemo(() => {
    const counts = new Map<number, number>();
    images.forEach((item) => {
      Object.values(item.labels).forEach((label) => {
        const id = label.label_option_id;
        counts.set(id, (counts.get(id) || 0) + 1);
      });
    });
    return counts;
  }, [images]);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="brand">Labeling Studio</div>
          <div className="subtle">
            Multi-category labeling with SQLite + uploads
          </div>
        </div>
        <div className="actions">
          <div className="filter-toggle">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={filterEnabled}
                onChange={(event) => setFilterEnabled(event.target.checked)}
              />
              <span>Filter</span>
            </label>
            {filterEnabled && (
              <div className="filter-dropdown">
                <div className="filter-mode">
                  <button
                    className={`btn small ${
                      filterMode === "any" ? "primary" : "ghost"
                    }`}
                    onClick={() => setFilterMode("any")}
                    type="button"
                  >
                    Any
                  </button>
                  <button
                    className={`btn small ${
                      filterMode === "all" ? "primary" : "ghost"
                    }`}
                    onClick={() => setFilterMode("all")}
                    type="button"
                  >
                    All
                  </button>
                  <button
                    className="btn ghost small"
                    onClick={clearFilterLabels}
                    type="button"
                  >
                    Clear
                  </button>
                </div>
                {categories.map((category) => (
                  <div key={category.id} className="filter-category">
                    <div className="filter-category-name">{category.name}</div>
                    <div className="filter-labels">
                      {category.labels.map((label) => (
                        <label key={label.id} className="checkbox">
                          <input
                            type="checkbox"
                            checked={filterLabelIds.has(label.id)}
                            onChange={() => toggleFilterLabel(label.id)}
                          />
                          <span>
                            {label.name} ({labelCounts.get(label.id) || 0})
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
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
          <button
            className="btn ghost"
            onClick={refreshImages}
            disabled={!selectedProjectId || loading}
            type="button"
          >
            Refresh
          </button>
          <button
            className="btn ghost"
            onClick={handleExport}
            disabled={!images.length}
            type="button"
          >
            Export CSV
          </button>
        </div>
      </header>

      <div className="content">
        <aside className="card sidebar">
          <div className="sidebar-header">
            <div>
              <div className="section-title">Projects</div>
              <div className="subtle">
                Upload multiple folders to create projects.
              </div>
            </div>
            <div className="stat">{projects.length}</div>
          </div>

          <div className="progress">
            <div className="progress-row">
              <span>
                {images.length
                  ? `Image ${currentIndex + 1} of ${images.length}`
                  : "No images"}
              </span>
              <span>{labeledCount} labeled</span>
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            {filterEnabled ? (
              <div className="filter-status">
                Showing {filteredIndexes.length} of {images.length} images
              </div>
            ) : null}
          </div>

          <div className="list">
            {projects.length ? (
              sidebarProjects
            ) : (
              <div className="empty-list">
                <div className="empty-icon">+</div>
                <div className="empty-title">Upload a folder to start</div>
                <div className="subtle">
                  Each folder becomes a separate project.
                </div>
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
                  <div className="subtle">
                    Use 1-9 for labels in the active category, arrows to
                    navigate, X to clear.
                  </div>
                </div>
              </div>

              <div className="image-shell">
                <img src={currentItem.url} alt={currentItem.filename} />
              </div>

              {filteredIndexes.length > 0 ? (
                <div className="preview-strip">
                  {filteredIndexes.map((index) => {
                    const item = images[index];
                    const active = index === currentIndex;
                    return (
                      <button
                        key={item.rel_path}
                        className={`preview-thumb ${active ? "active" : ""}`}
                        onClick={() => setCurrentIndex(index)}
                        type="button"
                      >
                        <img
                          src={item.url}
                          alt={item.filename}
                          loading="lazy"
                        />
                      </button>
                    );
                  })}
                </div>
              ) : null}

              <div className="label-panel">
                {categories.map((category) => {
                  const active = category.id === activeCategoryId;
                  const current = currentLabel(category.id);
                  return (
                    <div
                      key={category.id}
                      className={`category-block ${active ? "active" : ""}`}
                      onClick={() => setActiveCategoryId(category.id)}
                    >
                      <div className="category-header">
                        <div>
                          <div className="category-name">{category.name}</div>
                          <div className="subtle">
                            {active
                              ? "Shortcuts active"
                              : "Click to activate shortcuts"}
                          </div>
                        </div>
                        <button
                          className="btn ghost small"
                          onClick={(event) => {
                            event.stopPropagation();
                            clearLabel(category.id);
                          }}
                          disabled={!current}
                          type="button"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="label-row">
                        {category.labels.map((label, index) => (
                          <button
                            key={label.id}
                            type="button"
                            className={`label-button ${
                              current === label.name ? "active" : ""
                            }`}
                            onClick={(event) => {
                              event.stopPropagation();
                              applyLabel(category.id, label.id);
                            }}
                          >
                            <span>{label.name}</span>
                            {active && index < 9 ? (
                              <span className="keycap">{index + 1}</span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="label-add">
                <input
                  className="label-input"
                  value={newCategory}
                  onChange={(event) => setNewCategory(event.target.value)}
                  placeholder="Add a new category"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleAddCategory();
                    }
                  }}
                />
                <button
                  className="btn"
                  onClick={handleAddCategory}
                  disabled={!newCategory.trim()}
                  type="button"
                >
                  Add Category
                </button>
              </div>

              <div className="label-manage">
                <div className="section-title">Manage Categories & Labels</div>
                {categories.map((category) => (
                  <div key={category.id} className="manage-category">
                    <div className="manage-category-header">
                      {editingCategoryId === category.id ? (
                        <input
                          className="label-inline-input"
                          value={editingCategoryName}
                          onChange={(event) =>
                            setEditingCategoryName(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              handleRenameCategory();
                            }
                            if (event.key === "Escape") {
                              setEditingCategoryId(null);
                              setEditingCategoryName("");
                            }
                          }}
                        />
                      ) : (
                        <span className="label-name">{category.name}</span>
                      )}
                      <div className="label-actions">
                        {editingCategoryId === category.id ? (
                          <>
                            <button
                              className="btn small"
                              onClick={handleRenameCategory}
                              type="button"
                            >
                              Save
                            </button>
                            <button
                              className="btn ghost small"
                              onClick={() => {
                                setEditingCategoryId(null);
                                setEditingCategoryName("");
                              }}
                              type="button"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn ghost small"
                              onClick={() => {
                                setEditingCategoryId(category.id);
                                setEditingCategoryName(category.name);
                              }}
                              type="button"
                            >
                              Edit
                            </button>
                            <button
                              className="btn ghost small"
                              onClick={() => handleDeleteCategory(category.id)}
                              type="button"
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="manage-label-add">
                      <input
                        className="label-input"
                        value={newLabelByCategory[category.id] || ""}
                        onChange={(event) =>
                          setNewLabelByCategory((prev) => ({
                            ...prev,
                            [category.id]: event.target.value,
                          }))
                        }
                        placeholder={`Add label to ${category.name}`}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            handleAddLabel(category.id);
                          }
                        }}
                      />
                      <button
                        className="btn"
                        onClick={() => handleAddLabel(category.id)}
                        disabled={!newLabelByCategory[category.id]?.trim()}
                        type="button"
                      >
                        Add Label
                      </button>
                    </div>

                    <div className="manage-label-list">
                      {category.labels.map((label) => (
                        <div key={label.id} className="label-item">
                          {editingLabelId === label.id ? (
                            <input
                              className="label-inline-input"
                              value={editingLabelName}
                              onChange={(event) =>
                                setEditingLabelName(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  handleRenameLabel();
                                }
                                if (event.key === "Escape") {
                                  setEditingLabelId(null);
                                  setEditingLabelName("");
                                }
                              }}
                            />
                          ) : (
                            <span className="label-name">{label.name}</span>
                          )}
                          <div className="label-actions">
                            {editingLabelId === label.id ? (
                              <>
                                <button
                                  className="btn small"
                                  onClick={handleRenameLabel}
                                  type="button"
                                >
                                  Save
                                </button>
                                <button
                                  className="btn ghost small"
                                  onClick={() => {
                                    setEditingLabelId(null);
                                    setEditingLabelName("");
                                  }}
                                  type="button"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  className="btn ghost small"
                                  onClick={() => {
                                    setEditingLabelId(label.id);
                                    setEditingLabelName(label.name);
                                  }}
                                  type="button"
                                >
                                  Edit
                                </button>
                                <button
                                  className="btn ghost small"
                                  onClick={() => handleDeleteLabel(label.id)}
                                  type="button"
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="export-panel">
                <div className="export-header">
                  <div className="section-title">Export Selection</div>
                  <div className="label-actions">
                    <button
                      className="btn ghost small"
                      onClick={selectAllLabels}
                      type="button"
                    >
                      Select All
                    </button>
                    <button
                      className="btn ghost small"
                      onClick={clearAllLabels}
                      type="button"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <label className="checkbox export-toggle">
                  <input
                    type="checkbox"
                    checked={exportOnlySelected}
                    onChange={(event) =>
                      setExportOnlySelected(event.target.checked)
                    }
                  />
                  <span>Only export images that match selected labels</span>
                </label>
                {categories.map((category) => (
                  <div key={category.id} className="export-category">
                    <div className="export-category-name">{category.name}</div>
                    <div className="export-labels">
                      {category.labels.map((label) => (
                        <label key={label.id} className="checkbox">
                          <input
                            type="checkbox"
                            checked={selectedLabelIds.has(label.id)}
                            onChange={() => toggleLabelSelection(label.id)}
                          />
                          <span>{label.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="nav-row">
                <button
                  className="btn"
                  onClick={goPrev}
                  disabled={currentIndex <= 0}
                  type="button"
                >
                  Prev
                </button>
                <button
                  className="btn ghost"
                  onClick={skip}
                  disabled={currentIndex >= images.length - 1}
                  type="button"
                >
                  Skip
                </button>
                <button
                  className="btn"
                  onClick={goNext}
                  disabled={currentIndex >= images.length - 1}
                  type="button"
                >
                  Next
                </button>
              </div>
            </>
          ) : (
            <div className="empty-viewer">
              <div className="empty-title">No images loaded</div>
              <div className="subtle">
                Upload a folder or pick a project from the sidebar to start
                labeling.
              </div>
              <div className="empty-hint">
                Tip: You can add categories and labels anytime.
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
