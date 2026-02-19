import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];
const LABEL_KEY_SEPARATOR = "\u0000";

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
  thumbnail_url: string;
  labels: Record<number, ImageLabel[]>;
};

type ProjectResponse = {
  projects: Project[];
};

type ImagesResponse = {
  images: Array<{
    rel_path: string;
    filename: string;
    url: string;
    thumbnail_url: string;
    labels: ImageLabel[];
  }>;
  last_index: number;
};

type LabelSchemaResponse = {
  categories: LabelCategory[];
};

type LabelCountEntry = {
  category_id: number;
  category_name: string;
  label_id: number;
  label_name: string;
  count: number;
};

type CategoryCountEntry = {
  category_id: number;
  category_name: string;
  count: number;
};

type LabelCountsResponse = {
  labels: LabelCountEntry[];
  categories: CategoryCountEntry[];
};

type ExportProjectData = {
  id: number;
  name: string;
  images: ImageItem[];
  categories: LabelCategory[];
};

type ProjectCounts = {
  labelCounts: Map<string, number>;
  categoryCounts: Map<string, number>;
};

type SchemaTemplateCategory = {
  name: string;
  labels: string[];
};

type SchemaTemplateGroup = {
  signature: string;
  categories: SchemaTemplateCategory[];
  projectIds: number[];
  projectNames: string[];
};

type SchemaCategoryDiff = {
  name: string;
  status: "added" | "removed" | "changed" | "same";
  labels: string[];
  addedLabels: string[];
  removedLabels: string[];
};

type SchemaTemplateDiff = {
  addedCategories: number;
  removedCategories: number;
  addedLabels: number;
  removedLabels: number;
  unchangedCategories: number;
  hasChanges: boolean;
  categories: SchemaCategoryDiff[];
};

const normalizeSchemaCategories = (
  categories: LabelCategory[]
): SchemaTemplateCategory[] =>
  categories
    .map((category) => ({
      name: category.name.trim(),
      labels: Array.from(
        new Set(
          category.labels
            .map((label) => label.name.trim())
            .filter((name) => name.length > 0)
        )
      ),
    }))
    .filter((category) => category.name.length > 0);

const buildSchemaSignature = (categories: SchemaTemplateCategory[]): string =>
  JSON.stringify(
    categories
      .map((category) => ({
        name: category.name,
        labels: [...category.labels].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  );

const diffSchemaAgainstCurrent = (
  source: SchemaTemplateCategory[],
  current: SchemaTemplateCategory[]
): SchemaTemplateDiff => {
  const currentByName = new Map<string, Set<string>>();
  current.forEach((category) => {
    currentByName.set(category.name, new Set(category.labels));
  });

  let addedCategories = 0;
  let removedCategories = 0;
  let addedLabels = 0;
  let removedLabels = 0;
  let unchangedCategories = 0;
  const seenCategoryNames = new Set<string>();

  const categories: SchemaCategoryDiff[] = source.map((category) => {
    const currentLabels = currentByName.get(category.name);
    seenCategoryNames.add(category.name);
    if (!currentLabels) {
      addedCategories += 1;
      addedLabels += category.labels.length;
      return {
        name: category.name,
        status: "added",
        labels: [...category.labels],
        addedLabels: [...category.labels],
        removedLabels: [],
      };
    }

    const missingLabels = category.labels.filter(
      (label) => !currentLabels.has(label)
    );
    const extraLabels = Array.from(currentLabels).filter(
      (label) => !category.labels.includes(label)
    );
    if (missingLabels.length > 0 || extraLabels.length > 0) {
      addedLabels += missingLabels.length;
      removedLabels += extraLabels.length;
      return {
        name: category.name,
        status: "changed",
        labels: [...category.labels],
        addedLabels: missingLabels,
        removedLabels: extraLabels,
      };
    }

    unchangedCategories += 1;
    return {
      name: category.name,
      status: "same",
      labels: [...category.labels],
      addedLabels: [],
      removedLabels: [],
    };
  });

  current.forEach((category) => {
    if (seenCategoryNames.has(category.name)) {
      return;
    }
    removedCategories += 1;
    removedLabels += category.labels.length;
    categories.push({
      name: category.name,
      status: "removed",
      labels: [...category.labels],
      addedLabels: [],
      removedLabels: [...category.labels],
    });
  });

  return {
    addedCategories,
    removedCategories,
    addedLabels,
    removedLabels,
    unchangedCategories,
    hasChanges:
      addedCategories > 0 || removedCategories > 0 || addedLabels > 0 || removedLabels > 0,
    categories,
  };
};

const isSupported = (file: File) => {
  const lower = file.name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

const escapeCsv = (value: string) => {
  const escaped = value.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildLabelKey = (categoryName: string, labelName: string) =>
  `${categoryName}${LABEL_KEY_SEPARATOR}${labelName}`;

type ExportTable = {
  header: string[];
  rows: string[][];
};

const buildExportTable = (
  projects: ExportProjectData[],
  selectedLabelKeys: Set<string>,
  onlySelected: boolean
): ExportTable => {
  const hasSelection = selectedLabelKeys.size > 0;
  const selectedCategoryNames = new Set<string>();

  if (hasSelection) {
    selectedLabelKeys.forEach((key) => {
      const separatorIndex = key.indexOf(LABEL_KEY_SEPARATOR);
      if (separatorIndex === -1) return;
      const categoryName = key.slice(0, separatorIndex);
      if (categoryName) {
        selectedCategoryNames.add(categoryName);
      }
    });
  }

  const categoryNames: string[] = [];
  const seenCategories = new Set<string>();

  if (hasSelection) {
    projects.forEach((project) => {
      project.categories.forEach((category) => {
        if (!selectedCategoryNames.has(category.name)) {
          return;
        }
        if (!seenCategories.has(category.name)) {
          seenCategories.add(category.name);
          categoryNames.push(category.name);
        }
      });
    });
  }

  const includeProject = projects.length > 1;
  const header = [
    ...(includeProject ? ["project"] : []),
    "filename",
    ...categoryNames,
  ];

  const rows: string[][] = [];

  projects.forEach((project) => {
    const categoryNameById = new Map<number, string>();
    project.categories.forEach((category) => {
      categoryNameById.set(category.id, category.name);
    });

    project.images.forEach((item) => {
      const rowLabels = new Map<string, string[]>();
      let matchesSelection = false;

      if (hasSelection) {
        Object.values(item.labels).forEach((labels) => {
          labels.forEach((label) => {
            const categoryName = categoryNameById.get(label.category_id);
            if (!categoryName) return;
            const key = buildLabelKey(categoryName, label.label_name);
            if (!selectedLabelKeys.has(key)) return;
            const existing = rowLabels.get(categoryName) || [];
            if (!existing.includes(label.label_name)) {
              existing.push(label.label_name);
            }
            rowLabels.set(categoryName, existing);
            matchesSelection = true;
          });
        });
      }

      if (onlySelected && (!hasSelection || !matchesSelection)) {
        return;
      }

      const values = categoryNames.map((name) =>
        rowLabels.get(name)?.join("; ") || ""
      );
      const row = [
        ...(includeProject ? [project.name] : []),
        item.rel_path,
        ...values,
      ];
      rows.push(row);
    });
  });

  return { header, rows };
};

const buildCsvFromTable = (table: ExportTable) => {
  const header = table.header.map(escapeCsv).join(",");
  const rows = table.rows.map((row) => row.map(escapeCsv).join(","));
  return [header, ...rows].join("\n");
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

const serializeForScript = (value: string) =>
  JSON.stringify(value).replace(/<\/script>/gi, "<\\/script>");

const buildPreviewHtml = (
  table: ExportTable,
  filename: string,
  csv: string
) => {
  const columnCount = Math.max(table.header.length, 1);
  const headerHtml = table.header
    .map((cell) => `<th>${escapeHtml(cell)}</th>`)
    .join("");
  const bodyHtml = table.rows.length
    ? table.rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell) => `<td>${escapeHtml(cell)}</td>`)
              .join("")}</tr>`
        )
        .join("")
    : `<tr><td class="empty" colspan="${columnCount}">No rows to export.</td></tr>`;
  const csvValue = serializeForScript(csv);
  const filenameValue = serializeForScript(filename);
  const filenameHtml = escapeHtml(filename);
  const rowCount = table.rows.length.toLocaleString();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CSV Preview</title>
    <style>
      :root {
        color-scheme: light;
      }
      body {
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        margin: 0;
        background: #f8f4ee;
        color: #1f1b16;
      }
      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 24px;
        background: #fff;
        border-bottom: 1px solid rgba(31, 27, 22, 0.1);
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .toolbar h1 {
        font-size: 18px;
        margin: 0;
      }
      .toolbar .meta {
        font-size: 12px;
        color: #6d645b;
      }
      .toolbar-actions {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .filename-input {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 11px;
        color: #6d645b;
      }
      .filename-input input {
        min-width: 220px;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid rgba(31, 27, 22, 0.12);
        font-size: 12px;
        font-family: inherit;
      }
      .btn {
        border: 1px solid rgba(31, 27, 22, 0.12);
        background: #fff;
        padding: 8px 14px;
        border-radius: 10px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn.primary {
        background: linear-gradient(135deg, #f97316, #ea580c);
        color: #fff;
        border-color: transparent;
      }
      .table-wrap {
        padding: 16px 24px 32px;
        overflow: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: #fff;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 12px 24px rgba(31, 27, 22, 0.08);
      }
      th,
      td {
        padding: 10px 12px;
        border-bottom: 1px solid rgba(31, 27, 22, 0.08);
        text-align: left;
        font-size: 13px;
        vertical-align: top;
        word-break: break-word;
      }
      th {
        background: #f5ede3;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      tr:nth-child(even) td {
        background: #fcfaf7;
      }
      .empty {
        text-align: center;
        color: #6d645b;
        font-style: italic;
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <div>
        <h1>CSV Preview</h1>
        <div class="meta">Rows: ${rowCount}</div>
      </div>
      <div class="toolbar-actions">
        <label class="filename-input">
          <span>Filename</span>
          <input id="filename" value="${filenameHtml}" />
        </label>
        <button class="btn primary" id="download">Download CSV</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>${headerHtml}</tr>
        </thead>
        <tbody>
          ${bodyHtml}
        </tbody>
      </table>
    </div>
    <script>
      const csvData = ${csvValue};
      const filename = ${filenameValue};
      const filenameInput = document.getElementById("filename");
      const downloadBtn = document.getElementById("download");
      downloadBtn.addEventListener("click", () => {
        let nextName = filenameInput && "value" in filenameInput
          ? String(filenameInput.value || "").trim()
          : "";
        if (!nextName) {
          nextName = filename;
        }
        if (nextName && !nextName.toLowerCase().endsWith(".csv")) {
          nextName = nextName + ".csv";
        }
        const blob = new Blob([csvData], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = nextName || "labels.csv";
        link.click();
        URL.revokeObjectURL(url);
      });
    </script>
  </body>
</html>`;
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
    const labels: Record<number, ImageLabel[]> = {};
    item.labels.forEach((label) => {
      const list = labels[label.category_id] || [];
      list.push(label);
      labels[label.category_id] = list;
    });
    return {
      rel_path: item.rel_path,
      filename: item.filename,
      url: item.url,
      thumbnail_url: item.thumbnail_url,
      labels,
    };
  });
};

const buildProjectCountsFromImages = (
  items: ImageItem[],
  categories: LabelCategory[]
): ProjectCounts => {
  const categoryNameById = new Map<number, string>();
  categories.forEach((category) => {
    categoryNameById.set(category.id, category.name);
  });

  const labelCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  items.forEach((item) => {
    Object.entries(item.labels).forEach(([catIdStr, labels]) => {
      const categoryId = Number(catIdStr);
      const categoryName = categoryNameById.get(categoryId);
      if (!categoryName) return;
      categoryCounts.set(
        categoryName,
        (categoryCounts.get(categoryName) || 0) + 1
      );
      labels.forEach((label) => {
        const key = buildLabelKey(categoryName, label.label_name);
        labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
      });
    });
  });

  return { labelCounts, categoryCounts };
};

const buildProjectCountsFromResponse = (
  response: LabelCountsResponse
): ProjectCounts => {
  const labelCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  response.labels.forEach((row) => {
    const key = buildLabelKey(row.category_name, row.label_name);
    labelCounts.set(key, (labelCounts.get(key) || 0) + row.count);
  });

  response.categories.forEach((row) => {
    categoryCounts.set(
      row.category_name,
      (categoryCounts.get(row.category_name) || 0) + row.count
    );
  });

  return { labelCounts, categoryCounts };
};

const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(
    null
  );
  const [images, setImages] = useState<ImageItem[]>([]);
  const [imagesProjectId, setImagesProjectId] = useState<number | null>(null);
  const [categories, setCategories] = useState<LabelCategory[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null);
  const [activeCategoryName, setActiveCategoryName] = useState<string | null>(
    null
  );
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
  const [editingProjectId, setEditingProjectId] = useState<number | null>(null);
  const [editingProjectName, setEditingProjectName] = useState("");
  const [draggingCategoryId, setDraggingCategoryId] = useState<number | null>(
    null
  );
  const [dragOverCategoryId, setDragOverCategoryId] = useState<number | null>(
    null
  );
  const [manageCollapsed, setManageCollapsed] = useState(false);
  const [exportProjectsCollapsed, setExportProjectsCollapsed] = useState(false);
  const [exportSelectionCollapsed, setExportSelectionCollapsed] =
    useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [exportLabelKeys, setExportLabelKeys] = useState<Set<string>>(
    new Set()
  );
  const [exportOnlySelected, setExportOnlySelected] = useState(false);
  const [exportProjectIds, setExportProjectIds] = useState<Set<number>>(
    new Set()
  );
  const [exportCountsByProject, setExportCountsByProject] = useState<
    Map<number, ProjectCounts>
  >(new Map());
  const [exportProjectsTouched, setExportProjectsTouched] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deletingImage, setDeletingImage] = useState(false);
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterUseExportSelection, setFilterUseExportSelection] =
    useState(false);
  const [filterLabelKeys, setFilterLabelKeys] = useState<Set<string>>(
    new Set()
  );
  const [unlabeledOpen, setUnlabeledOpen] = useState(false);
  const [unlabeledCategoryIds, setUnlabeledCategoryIds] = useState<Set<number>>(
    new Set()
  );
  const [schemaExplorerOpen, setSchemaExplorerOpen] = useState(false);
  const [schemaExplorerLoading, setSchemaExplorerLoading] = useState(false);
  const [schemaExplorerError, setSchemaExplorerError] = useState<string | null>(
    null
  );
  const [schemaExplorerGroups, setSchemaExplorerGroups] = useState<
    SchemaTemplateGroup[]
  >([]);
  const [schemaApplyingSignature, setSchemaApplyingSignature] = useState<
    string | null
  >(null);
  const [filterMode, setFilterMode] = useState<"any" | "all">("any");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const manualFilterLabelKeysRef = useRef<Set<string>>(new Set());

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
        setImagesProjectId(projectId);
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
    setSchemaExplorerOpen(false);
    setSchemaExplorerError(null);
    setSchemaExplorerGroups([]);
    setSchemaApplyingSignature(null);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!projects.length) {
      setExportProjectIds(new Set());
      return;
    }

    const availableIds = new Set(projects.map((project) => project.id));

    setExportProjectIds((prev) => {
      const filtered = new Set<number>();
      prev.forEach((id) => {
        if (availableIds.has(id)) {
          filtered.add(id);
        }
      });

      if (!exportProjectsTouched) {
        if (selectedProjectId !== null && availableIds.has(selectedProjectId)) {
          return new Set([selectedProjectId]);
        }
        return filtered;
      }

      if (filtered.size === 0 && selectedProjectId !== null) {
        filtered.add(selectedProjectId);
      }

      return filtered;
    });
  }, [exportProjectsTouched, projects, selectedProjectId]);

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
      if (activeCategoryId !== null) {
        setActiveCategoryId(null);
      }
      return;
    }
    let nextActiveId = activeCategoryId;
    if (activeCategoryName) {
      const match = categories.find((c) => c.name === activeCategoryName);
      if (match) {
        nextActiveId = match.id;
      }
    }
    if (
      nextActiveId === null ||
      !categories.some((c) => c.id === nextActiveId)
    ) {
      nextActiveId = categories[0].id;
    }
    if (nextActiveId !== activeCategoryId) {
      setActiveCategoryId(nextActiveId);
    }
    const nextActiveCategory = categories.find((c) => c.id === nextActiveId);
    if (nextActiveCategory && nextActiveCategory.name !== activeCategoryName) {
      setActiveCategoryName(nextActiveCategory.name);
    }

    const availableLabelIds = new Set<number>();
    const availableExportLabelKeys = new Set<string>();
    categories.forEach((category) => {
      category.labels.forEach((label) => {
        availableLabelIds.add(label.id);
        availableExportLabelKeys.add(buildLabelKey(category.name, label.name));
      });
    });

    setExportLabelKeys((prev) => {
      const next = new Set<string>();
      prev.forEach((key) => {
        if (availableExportLabelKeys.has(key)) {
          next.add(key);
        }
      });
      if (next.size === 0) {
        availableExportLabelKeys.forEach((key) => next.add(key));
      }
      return next;
    });

    setImages((prev) =>
      prev.map((item) => {
        const nextLabels: Record<number, ImageLabel[]> = {};
        Object.values(item.labels).forEach((labels) => {
          labels.forEach((label) => {
            const labelInfo = labelById.get(label.label_option_id);
            if (!labelInfo) return;
            const list = nextLabels[label.category_id] || [];
            list.push({
              category_id: label.category_id,
              label_option_id: label.label_option_id,
              label_name: labelInfo.name,
            });
            nextLabels[label.category_id] = list;
          });
        });
        return { ...item, labels: nextLabels };
      })
    );
  }, [activeCategoryId, activeCategoryName, categories, labelById]);

  useEffect(() => {
    if (!filterUseExportSelection) {
      manualFilterLabelKeysRef.current = new Set(filterLabelKeys);
    }
  }, [filterLabelKeys, filterUseExportSelection]);

  useEffect(() => {
    if (filterUseExportSelection && !filterEnabled) {
      setFilterEnabled(true);
    }
  }, [filterEnabled, filterUseExportSelection]);

  useEffect(() => {
    if (!filterUseExportSelection) return;
    setFilterLabelKeys(new Set(exportLabelKeys));
  }, [exportLabelKeys, filterUseExportSelection]);

  useEffect(() => {
    const availableCategoryIds = new Set(categories.map((category) => category.id));
    setUnlabeledCategoryIds((prev) => {
      let changed = false;
      const next = new Set<number>();
      prev.forEach((id) => {
        if (availableCategoryIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [categories]);

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

  const labeledCount = useMemo(
    () => images.filter((item) => Object.keys(item.labels).length > 0).length,
    [images]
  );

  const unlabeledCategoryCounts = useMemo(() => {
    const counts = new Map<number, number>();
    categories.forEach((category) => counts.set(category.id, 0));
    images.forEach((item) => {
      categories.forEach((category) => {
        if ((item.labels[category.id]?.length || 0) === 0) {
          counts.set(category.id, (counts.get(category.id) || 0) + 1);
        }
      });
    });
    return counts;
  }, [categories, images]);

  const progressPercent = images.length
    ? Math.round((labeledCount / images.length) * 100)
    : 0;

  const filteredIndexes = useMemo(() => {
    if (!images.length) return [] as number[];
    const selectedUnlabeledCategories = Array.from(unlabeledCategoryIds);
    const hasUnlabeledCategoryFilter = selectedUnlabeledCategories.length > 0;
    const hasLabelFilter = filterEnabled && filterLabelKeys.size > 0;
    if (!hasLabelFilter && !hasUnlabeledCategoryFilter) {
      return images.map((_, index) => index);
    }
    const selected = hasLabelFilter ? Array.from(filterLabelKeys) : [];
    const selectedByCategory = new Map<string, string[]>();
    selected.forEach((key) => {
      const separatorIndex = key.indexOf(LABEL_KEY_SEPARATOR);
      const categoryName =
        separatorIndex >= 0 ? key.slice(0, separatorIndex) : "";
      if (!categoryName) return;
      const list = selectedByCategory.get(categoryName) || [];
      list.push(key);
      selectedByCategory.set(categoryName, list);
    });
    const categoryNameById = new Map<number, string>();
    categories.forEach((category) => {
      categoryNameById.set(category.id, category.name);
    });
    return images
      .map((item, index) => {
        if (hasLabelFilter) {
          const itemLabels = Object.values(item.labels)
            .flat()
            .map((label) => {
              const categoryName = categoryNameById.get(label.category_id);
              if (!categoryName) return null;
              return buildLabelKey(categoryName, label.label_name);
            })
            .filter((key): key is string => Boolean(key));
          const itemLabelSet = new Set(itemLabels);
          const labelMatch =
            filterMode === "all"
              ? Array.from(selectedByCategory.values()).every((keys) =>
                  keys.some((key) => itemLabelSet.has(key))
                )
              : selected.some((key) => itemLabelSet.has(key));
          if (!labelMatch) {
            return -1;
          }
        }
        if (hasUnlabeledCategoryFilter) {
          const missingSelectedCategory = selectedUnlabeledCategories.some(
            (categoryId) => (item.labels[categoryId]?.length || 0) === 0
          );
          if (!missingSelectedCategory) {
            return -1;
          }
        }
        return index;
      })
      .filter((index) => index >= 0);
  }, [
    categories,
    filterEnabled,
    filterLabelKeys,
    filterMode,
    images,
    unlabeledCategoryIds,
  ]);

  const hasActiveLabelSelection = filterEnabled && filterLabelKeys.size > 0;
  const hasActiveUnlabeledSelection = unlabeledCategoryIds.size > 0;
  const hasActiveFilter = hasActiveLabelSelection || hasActiveUnlabeledSelection;
  const hasFilteredResults = filteredIndexes.length > 0;
  const showFilteredEmpty =
    hasActiveFilter && images.length > 0 && !hasFilteredResults;
  const currentItem =
    hasActiveFilter && !hasFilteredResults
      ? null
      : images[currentIndex] || null;
  const currentLabels = (categoryId: number) =>
    currentItem?.labels[categoryId] || [];

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

  const applyLabel = useCallback(
    async (
      categoryId: number,
      labelOptionId: number,
      options: { mode?: "replace" | "toggle"; advance?: boolean } = {}
    ) => {
      if (!currentItem || selectedProjectId === null) return;
      const relPath = currentItem.rel_path;
      const mode = options.mode ?? "replace";
      const advance = options.advance ?? mode === "replace";
      try {
        await fetchJson(`/api/projects/${selectedProjectId}/labels`, {
          method: "POST",
          body: JSON.stringify({
            rel_path: relPath,
            category_id: categoryId,
            label_option_id: labelOptionId,
            mode,
          }),
        });

        const labelInfo = labelById.get(labelOptionId);
        if (!labelInfo) return;
        const nextLabel: ImageLabel = {
          category_id: categoryId,
          label_option_id: labelOptionId,
          label_name: labelInfo.name,
        };

        const applyLabelUpdate = (
          labels: Record<number, ImageLabel[]>
        ): Record<number, ImageLabel[]> => {
          const nextLabels = { ...labels };
          if (mode === "replace") {
            nextLabels[categoryId] = [nextLabel];
            return nextLabels;
          }
          const existing = nextLabels[categoryId]
            ? [...nextLabels[categoryId]]
            : [];
          const existingIndex = existing.findIndex(
            (label) => label.label_option_id === labelOptionId
          );
          if (existingIndex >= 0) {
            existing.splice(existingIndex, 1);
          } else {
            existing.push(nextLabel);
          }
          if (existing.length > 0) {
            nextLabels[categoryId] = existing;
          } else {
            delete nextLabels[categoryId];
          }
          return nextLabels;
        };

        setImages((prev) =>
          prev.map((item, index) =>
            index === currentIndex
              ? { ...item, labels: applyLabelUpdate(item.labels) }
              : item
          )
        );

        const nextImages = images.map((item, index) =>
          index === currentIndex
            ? { ...item, labels: applyLabelUpdate(item.labels) }
            : item
        );
        updateProjectCounts(selectedProjectId, nextImages);
        if (advance) {
          goNext();
        }
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
      goNext,
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
      if (editingCategoryId === activeCategoryId) {
        setActiveCategoryName(name);
      }
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
            Object.entries(nextLabels).forEach(([catId, labels]) => {
              const remaining = labels.filter(
                (label) => label.label_option_id !== labelId
              );
              if (remaining.length > 0) {
                nextLabels[Number(catId)] = remaining;
              } else {
                delete nextLabels[Number(catId)];
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

  const handleExport = useCallback(async () => {
    const projectIds = exportProjectIds.size
      ? Array.from(exportProjectIds)
      : selectedProjectId !== null
        ? [selectedProjectId]
        : [];

    if (!projectIds.length) return;

    const projectIdSet = new Set(projectIds);
    const exportProjects = projects.filter((project) =>
      projectIdSet.has(project.id)
    );
    if (!exportProjects.length) return;

    const previewWindow = window.open("", "_blank");
    if (!previewWindow) {
      setError("Popup blocked. Allow popups to preview the CSV.");
      return;
    }
    previewWindow.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CSV Preview</title>
    <style>
      body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; padding: 24px; }
    </style>
  </head>
  <body>
    <h1>Preparing CSV preview...</h1>
    <p>Please keep this tab open.</p>
  </body>
</html>`);
    previewWindow.document.close();

    setExporting(true);
    setError(null);
    try {
      const data = await Promise.all(
        exportProjects.map(async (project) => {
          const [imagesRes, schemaRes] = await Promise.all([
            fetchJson<ImagesResponse>(`/api/projects/${project.id}/images`),
            fetchJson<LabelSchemaResponse>(
              `/api/projects/${project.id}/label-schema`
            ),
          ]);
          return {
            id: project.id,
            name: project.name,
            images: normalizeImages(imagesRes.images),
            categories: schemaRes.categories,
          };
        })
      );

      const table = buildExportTable(data, exportLabelKeys, exportOnlySelected);
      const csv = buildCsvFromTable(table);
      const filename = data.length > 1 ? "labels_multi.csv" : "labels.csv";
      if (!previewWindow.closed) {
        previewWindow.document.open();
        previewWindow.document.write(buildPreviewHtml(table, filename, csv));
        previewWindow.document.close();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export CSV");
      if (!previewWindow.closed) {
        previewWindow.document.open();
        previewWindow.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CSV Preview Failed</title>
  </head>
  <body>
    <h1>Failed to build CSV preview</h1>
    <p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>
  </body>
</html>`);
        previewWindow.document.close();
      }
    } finally {
      setExporting(false);
    }
  }, [
    exportLabelKeys,
    exportOnlySelected,
    exportProjectIds,
    projects,
    selectedProjectId,
  ]);

  const handleDeleteImage = useCallback(async () => {
    if (!currentItem || selectedProjectId === null) return;
    if (
      !window.confirm(
        `Delete ${currentItem.rel_path}? This cannot be undone.`
      )
    ) {
      return;
    }

    const nextIndex = currentIndex;
    setDeletingImage(true);
    setError(null);
    try {
      await fetchJson(
        `/api/projects/${selectedProjectId}/image?path=${encodeURIComponent(
          currentItem.rel_path
        )}`,
        { method: "DELETE" }
      );
      const imagesRes = await fetchJson<ImagesResponse>(
        `/api/projects/${selectedProjectId}/images`
      );
      const normalized = normalizeImages(imagesRes.images);
      setImages(normalized);
      setImagesProjectId(selectedProjectId);
      updateProjectCounts(selectedProjectId, normalized);
      if (normalized.length === 0) {
        setCurrentIndex(0);
      } else if (nextIndex >= normalized.length) {
        setCurrentIndex(normalized.length - 1);
      } else {
        setCurrentIndex(nextIndex);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete image"
      );
    } finally {
      setDeletingImage(false);
    }
  }, [
    currentIndex,
    currentItem,
    selectedProjectId,
    updateProjectCounts,
  ]);

  const toggleExportProject = useCallback((projectId: number) => {
    setExportProjectsTouched(true);
    setExportProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        if (next.size === 1) {
          return next;
        }
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  const selectAllExportProjects = useCallback(() => {
    setExportProjectsTouched(true);
    setExportProjectIds(new Set(projects.map((project) => project.id)));
  }, [projects]);

  const useCurrentProjectForExport = useCallback(() => {
    if (selectedProjectId === null) return;
    setExportProjectsTouched(false);
    setExportProjectIds(new Set([selectedProjectId]));
  }, [selectedProjectId]);

  const persistCategoryOrder = useCallback(
    async (nextCategories: LabelCategory[], previousCategories: LabelCategory[]) => {
      if (selectedProjectId === null) return;
      try {
        const response = await fetchJson<LabelSchemaResponse>(
          `/api/projects/${selectedProjectId}/label-categories/order`,
          {
            method: "POST",
            body: JSON.stringify({
              order: nextCategories.map((category) => category.id),
            }),
          }
        );
        setCategories(response.categories);
      } catch (err) {
        setCategories(previousCategories);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to update category order"
        );
      }
    },
    [selectedProjectId]
  );

  const handleCategoryDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, categoryId: number) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(categoryId));
      setDraggingCategoryId(categoryId);
    },
    []
  );

  const handleCategoryDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    []
  );

  const handleCategoryDragEnter = useCallback(
    (categoryId: number) => {
      if (draggingCategoryId === null || draggingCategoryId === categoryId) {
        return;
      }
      setDragOverCategoryId(categoryId);
    },
    [draggingCategoryId]
  );

  const handleCategoryDragEnd = useCallback(() => {
    setDraggingCategoryId(null);
    setDragOverCategoryId(null);
  }, []);

  const handleCategoryDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>, targetId: number) => {
      event.preventDefault();
      const sourceId = Number(event.dataTransfer.getData("text/plain"));
      if (!sourceId || sourceId === targetId) {
        setDragOverCategoryId(null);
        return;
      }

      const sourceIndex = categories.findIndex(
        (category) => category.id === sourceId
      );
      const targetIndex = categories.findIndex(
        (category) => category.id === targetId
      );
      if (sourceIndex < 0 || targetIndex < 0) {
        setDragOverCategoryId(null);
        return;
      }

      const nextCategories = [...categories];
      const [moved] = nextCategories.splice(sourceIndex, 1);
      nextCategories.splice(targetIndex, 0, moved);
      setCategories(nextCategories);
      setDragOverCategoryId(null);
      setDraggingCategoryId(null);
      void persistCategoryOrder(nextCategories, categories);
    },
    [categories, persistCategoryOrder]
  );

  const toggleLabelSelection = useCallback((labelKey: string) => {
    setExportLabelKeys((prev) => {
      const next = new Set(prev);
      if (next.has(labelKey)) {
        next.delete(labelKey);
      } else {
        next.add(labelKey);
      }
      return next;
    });
  }, []);

  const selectAllLabels = useCallback(() => {
    const all = new Set<string>();
    categories.forEach((category) =>
      category.labels.forEach((label) =>
        all.add(buildLabelKey(category.name, label.name))
      )
    );
    setExportLabelKeys(all);
  }, [categories]);

  const clearAllLabels = useCallback(() => {
    setExportLabelKeys(new Set());
  }, []);

  const toggleFilterLabel = useCallback((labelKey: string, checked: boolean) => {
    setFilterLabelKeys((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(labelKey);
      } else {
        next.delete(labelKey);
      }
      return next;
    });
    if (checked) {
      setFilterEnabled(true);
    }
  }, []);

  const clearFilterLabels = useCallback(() => {
    setFilterLabelKeys(new Set());
  }, []);

  const toggleUnlabeledCategory = useCallback(
    (categoryId: number, checked: boolean) => {
      setUnlabeledCategoryIds((prev) => {
        const next = new Set(prev);
        if (checked) {
          next.add(categoryId);
        } else {
          next.delete(categoryId);
        }
        return next;
      });
      if (checked) {
        setActiveCategoryId(categoryId);
        const category = categories.find((item) => item.id === categoryId);
        if (category) {
          setActiveCategoryName(category.name);
        }
      }
    },
    [categories]
  );

  const clearUnlabeledCategories = useCallback(() => {
    setUnlabeledCategoryIds(new Set());
  }, []);

  const handleFilterUseExportSelection = useCallback(
    (checked: boolean) => {
      if (checked) {
        manualFilterLabelKeysRef.current = new Set(filterLabelKeys);
      }
      setFilterUseExportSelection(checked);
      if (checked) {
        setFilterEnabled(true);
        setFilterLabelKeys(new Set(exportLabelKeys));
      } else {
        setFilterLabelKeys(new Set(manualFilterLabelKeysRef.current));
      }
    },
    [exportLabelKeys, filterLabelKeys]
  );

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
      } else {
        const digitMatch =
          event.code.match(/^Digit([1-9])$/) ||
          event.code.match(/^Numpad([1-9])$/);
        if (digitMatch) {
          if (!activeCategoryId) return;
          const category = categories.find((c) => c.id === activeCategoryId);
          if (!category) return;
          const index = Number(digitMatch[1]) - 1;
          if (category.labels[index]) {
            event.preventDefault();
            const toggle = event.shiftKey;
            applyLabel(activeCategoryId, category.labels[index].id, {
              mode: toggle ? "toggle" : "replace",
              advance: !toggle,
            });
          }
          return;
        }
        if (event.key.toLowerCase() === "x") {
          if (activeCategoryId && currentLabels(activeCategoryId).length > 0) {
            event.preventDefault();
            clearLabel(activeCategoryId);
          }
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
    currentLabels,
    goNext,
    goPrev,
  ]);

  const loadSchemaExplorer = useCallback(async () => {
    if (selectedProjectId === null) return;
    setSchemaExplorerLoading(true);
    setSchemaExplorerError(null);
    try {
      const projectsRes = await fetchJson<ProjectResponse>("/api/projects");
      const sourceProjects = projectsRes.projects.filter(
        (project) => project.id !== selectedProjectId
      );

      if (!sourceProjects.length) {
        setSchemaExplorerGroups([]);
        return;
      }

      const schemas = await Promise.all(
        sourceProjects.map(async (project) => {
          const schemaRes = await fetchJson<LabelSchemaResponse>(
            `/api/projects/${project.id}/label-schema`
          );
          return {
            project,
            categories: normalizeSchemaCategories(schemaRes.categories),
          };
        })
      );

      const grouped = new Map<string, SchemaTemplateGroup>();
      schemas.forEach(({ project, categories: schemaCategories }) => {
        if (!schemaCategories.length) return;
        const signature = buildSchemaSignature(schemaCategories);
        const existing = grouped.get(signature);
        if (existing) {
          existing.projectIds.push(project.id);
          existing.projectNames.push(project.name);
          return;
        }
        grouped.set(signature, {
          signature,
          categories: schemaCategories,
          projectIds: [project.id],
          projectNames: [project.name],
        });
      });

      const nextGroups = Array.from(grouped.values())
        .map((group) => ({
          ...group,
          projectNames: [...group.projectNames].sort((a, b) =>
            a.localeCompare(b)
          ),
        }))
        .sort((a, b) => {
          if (b.projectNames.length !== a.projectNames.length) {
            return b.projectNames.length - a.projectNames.length;
          }
          return (a.projectNames[0] || "").localeCompare(b.projectNames[0] || "");
        });

      setSchemaExplorerGroups(nextGroups);
    } catch (err) {
      setSchemaExplorerError(
        err instanceof Error ? err.message : "Failed to load existing schemas"
      );
      setSchemaExplorerGroups([]);
    } finally {
      setSchemaExplorerLoading(false);
    }
  }, [selectedProjectId]);

  const handleOpenSchemaExplorer = useCallback(() => {
    if (selectedProjectId === null) return;
    setSchemaExplorerOpen(true);
    void loadSchemaExplorer();
  }, [loadSchemaExplorer, selectedProjectId]);

  const handleApplySchemaGroup = useCallback(
    async (group: SchemaTemplateGroup) => {
      if (selectedProjectId === null) return;
      if (!group.categories.length) return;

      const sourceNames = group.projectNames.join(", ");
      if (
        !window.confirm(
          `Use schema from ${sourceNames}? This will sync the current project to this schema and remove categories/labels that are not part of it.`
        )
      ) {
        return;
      }

      setSchemaApplyingSignature(group.signature);
      setSchemaExplorerError(null);

      try {
        let currentCats = [...categories];
        const sourceCategoryNames = new Set(
          group.categories.map((category) => category.name)
        );

        for (const sourceCategory of group.categories) {
          let targetCategory = currentCats.find(
            (category) => category.name === sourceCategory.name
          );

          if (!targetCategory) {
            const res = await fetchJson<LabelSchemaResponse>(
              `/api/projects/${selectedProjectId}/label-categories`,
              {
                method: "POST",
                body: JSON.stringify({ name: sourceCategory.name }),
              }
            );
            currentCats = res.categories;
            targetCategory = currentCats.find(
              (category) => category.name === sourceCategory.name
            );
          }

          if (!targetCategory) continue;

          const sourceLabelNames = new Set(sourceCategory.labels);
          for (const existingLabel of [...targetCategory.labels]) {
            if (sourceLabelNames.has(existingLabel.name)) {
              continue;
            }
            const res = await fetchJson<LabelSchemaResponse>(
              `/api/projects/${selectedProjectId}/label-options`,
              {
                method: "DELETE",
                body: JSON.stringify({
                  label_id: existingLabel.id,
                }),
              }
            );
            currentCats = res.categories;
          }

          targetCategory = currentCats.find(
            (category) => category.name === sourceCategory.name
          );
          if (!targetCategory) continue;

          for (const sourceLabelName of sourceCategory.labels) {
            if (
              targetCategory.labels.some((label) => label.name === sourceLabelName)
            ) {
              continue;
            }

            const res = await fetchJson<LabelSchemaResponse>(
              `/api/projects/${selectedProjectId}/label-options`,
              {
                method: "POST",
                body: JSON.stringify({
                  category_id: targetCategory.id,
                  name: sourceLabelName,
                }),
              }
            );
            currentCats = res.categories;
            targetCategory = currentCats.find(
              (category) => category.id === targetCategory!.id
            );
            if (!targetCategory) break;
          }
        }

        for (const existingCategory of [...currentCats]) {
          if (sourceCategoryNames.has(existingCategory.name)) {
            continue;
          }
          const res = await fetchJson<LabelSchemaResponse>(
            `/api/projects/${selectedProjectId}/label-categories`,
            {
              method: "DELETE",
              body: JSON.stringify({
                category_id: existingCategory.id,
              }),
            }
          );
          currentCats = res.categories;
        }

        const orderedCategoryIds = group.categories
          .map((sourceCategory) =>
            currentCats.find((category) => category.name === sourceCategory.name)
              ?.id
          )
          .filter((id): id is number => typeof id === "number");

        if (orderedCategoryIds.length > 0) {
          const res = await fetchJson<LabelSchemaResponse>(
            `/api/projects/${selectedProjectId}/label-categories/order`,
            {
              method: "POST",
              body: JSON.stringify({
                order: orderedCategoryIds,
              }),
            }
          );
          currentCats = res.categories;
        }

        setCategories(currentCats);
        setSchemaExplorerOpen(false);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to apply schema";
        setSchemaExplorerError(message);
        setError(message);
      } finally {
        setSchemaApplyingSignature(null);
      }
    },
    [categories, selectedProjectId]
  );

  const cancelProjectEdit = useCallback(() => {
    setEditingProjectId(null);
    setEditingProjectName("");
  }, []);

  const startProjectEdit = useCallback((project: Project) => {
    setEditingProjectId(project.id);
    setEditingProjectName(project.name);
  }, []);

  const handleRenameProject = useCallback(async () => {
    if (editingProjectId === null) return;
    const name = editingProjectName.trim();
    if (!name) {
      setError("Project name required");
      return;
    }
    try {
      await fetchJson(`/api/projects/${editingProjectId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setProjects((prev) =>
        prev.map((project) =>
          project.id === editingProjectId ? { ...project, name } : project
        )
      );
      cancelProjectEdit();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to rename project");
    }
  }, [cancelProjectEdit, editingProjectId, editingProjectName]);

  const handleDeleteProject = async (projectId: number) => {
    if (
      !confirm(
        "Are you sure you want to delete this project? This cannot be undone."
      )
    ) {
      return;
    }
    try {
      await fetchJson(`/api/projects/${projectId}`, {
        method: "DELETE",
      });

      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
        setImages([]);
        setImagesProjectId(null);
        setCategories([]);
      }
    } catch (err) {
      console.error(err);
      setError("Failed to delete project");
    }
  };

  const sidebarProjects = useMemo(() => {
    if (!projects.length) return null;
    return projects.map((project) => (
      <div
        key={project.id}
        className={`list-item ${
          project.id === selectedProjectId ? "active" : ""
        }`}
        onClick={() => {
          if (editingProjectId !== project.id) {
            setSelectedProjectId(project.id);
          }
        }}
      >
        <div className="list-content">
          <div className="list-name">
            {editingProjectId === project.id ? (
              <input
                className="project-inline-input"
                value={editingProjectName}
                onChange={(event) => setEditingProjectName(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleRenameProject();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelProjectEdit();
                  }
                }}
                autoFocus
              />
            ) : (
              project.name
            )}
          </div>
          {editingProjectId !== project.id && (
            <div className="project-meta">
              {project.labeled_count}/{project.image_count}
            </div>
          )}
        </div>
        <div className="project-actions">
          {editingProjectId === project.id ? (
            <>
              <button
                className="btn small"
                onClick={(event) => {
                  event.stopPropagation();
                  handleRenameProject();
                }}
                type="button"
              >
                Save
              </button>
              <button
                className="btn ghost small"
                onClick={(event) => {
                  event.stopPropagation();
                  cancelProjectEdit();
                }}
                type="button"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                className="btn-icon edit-project"
                onClick={(event) => {
                  event.stopPropagation();
                  startProjectEdit(project);
                }}
                type="button"
                title="Rename project"
              >
                ✎
              </button>
              <button
                className="btn-icon delete-project"
                onClick={(event) => {
                  event.stopPropagation();
                  handleDeleteProject(project.id);
                }}
                type="button"
                title="Delete project"
              >
                ×
              </button>
            </>
          )}
        </div>
      </div>
    ));
  }, [
    cancelProjectEdit,
    editingProjectId,
    editingProjectName,
    handleRenameProject,
    projects,
    selectedProjectId,
    startProjectEdit,
  ]);

  const labelCounts = useMemo(() => {
    const counts = new Map<number, number>();
    images.forEach((item) => {
      Object.values(item.labels).forEach((labels) => {
        labels.forEach((label) => {
          const id = label.label_option_id;
          counts.set(id, (counts.get(id) || 0) + 1);
        });
      });
    });
    return counts;
  }, [images]);

  useEffect(() => {
    if (imagesProjectId === null) return;
    const counts = buildProjectCountsFromImages(images, categories);
    setExportCountsByProject((prev) => {
      const next = new Map(prev);
      next.set(imagesProjectId, counts);
      return next;
    });
  }, [categories, images, imagesProjectId]);

  useEffect(() => {
    if (!exportProjectIds.size) return;
    const missing = Array.from(exportProjectIds).filter(
      (projectId) => !exportCountsByProject.has(projectId)
    );
    if (!missing.length) return;
    let cancelled = false;
    const load = async () => {
      try {
        const results = await Promise.all(
          missing.map(async (projectId) => {
            const response = await fetchJson<LabelCountsResponse>(
              `/api/projects/${projectId}/label-counts`
            );
            return {
              projectId,
              counts: buildProjectCountsFromResponse(response),
            };
          })
        );
        if (cancelled) return;
        setExportCountsByProject((prev) => {
          const next = new Map(prev);
          results.forEach(({ projectId, counts }) => {
            next.set(projectId, counts);
          });
          return next;
        });
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load export counts"
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [exportCountsByProject, exportProjectIds]);

  const exportCounts = useMemo(() => {
    const labelCounts = new Map<string, number>();
    const categoryCounts = new Map<string, number>();
    exportProjectIds.forEach((projectId) => {
      const counts = exportCountsByProject.get(projectId);
      if (!counts) return;
      counts.labelCounts.forEach((value, key) => {
        labelCounts.set(key, (labelCounts.get(key) || 0) + value);
      });
      counts.categoryCounts.forEach((value, key) => {
        categoryCounts.set(key, (categoryCounts.get(key) || 0) + value);
      });
    });
    return { labelCounts, categoryCounts };
  }, [exportCountsByProject, exportProjectIds]);

  const labelPanelCategories = useMemo(() => {
    if (!categories.length || activeCategoryId === null) {
      return categories;
    }
    const activeIndex = categories.findIndex(
      (category) => category.id === activeCategoryId
    );
    if (activeIndex <= 0) {
      return categories;
    }
    const next = [...categories];
    const [active] = next.splice(activeIndex, 1);
    next.unshift(active);
    return next;
  }, [activeCategoryId, categories]);

  const schemaDiffBySignature = useMemo(() => {
    const currentSchema = normalizeSchemaCategories(categories);
    const next = new Map<string, SchemaTemplateDiff>();
    schemaExplorerGroups.forEach((group) => {
      next.set(group.signature, diffSchemaAgainstCurrent(group.categories, currentSchema));
    });
    return next;
  }, [categories, schemaExplorerGroups]);

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
          <div className="actions-group actions-left">
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
          </div>

          <div className="actions-group actions-center">
            <div className="filter-toggle">
              <button
                className={`btn ghost filter-trigger${
                  filterEnabled ? " active" : ""
                }`}
                onClick={() => setFilterOpen((prev) => !prev)}
                type="button"
                aria-pressed={filterEnabled}
                aria-expanded={filterOpen}
              >
                <span
                  className={`filter-dot${filterEnabled ? " active" : ""}`}
                  aria-hidden="true"
                />
                <span>Filter</span>
              </button>
              {filterOpen && (
                <div className="filter-dropdown">
                  <div className="filter-dropdown-header">
                    <div className="filter-dropdown-title">Filters</div>
                    <button
                      className="filter-close"
                      onClick={() => setFilterOpen(false)}
                      type="button"
                      aria-label="Close filters"
                    >
                      x
                    </button>
                  </div>
                  <div className="filter-switch-row">
                    <span className="filter-active-label">Filter active</span>
                    <button
                      className={`filter-switch${
                        filterEnabled ? " active" : ""
                      }`}
                      onClick={() => setFilterEnabled((prev) => !prev)}
                      type="button"
                      role="switch"
                      aria-checked={filterEnabled}
                      aria-label="Filter active"
                    >
                      <span className="filter-switch-thumb" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="filter-switch-row">
                    <span className="filter-active-label">
                      Use export selection
                    </span>
                    <button
                      className={`filter-switch${
                        filterUseExportSelection ? " active" : ""
                      }`}
                      onClick={() =>
                        handleFilterUseExportSelection(!filterUseExportSelection)
                      }
                      type="button"
                      role="switch"
                      aria-checked={filterUseExportSelection}
                      aria-label="Use export selection"
                    >
                      <span className="filter-switch-thumb" aria-hidden="true" />
                    </button>
                  </div>
                  {filterUseExportSelection ? (
                    <div className="filter-note subtle">
                      Export selection drives the filter.
                    </div>
                  ) : null}
                  <div className="filter-mode">
                    <button
                      className={`btn small filter-mode-tooltip ${
                        filterMode === "any" ? "primary" : "ghost"
                      }`}
                      onClick={() => setFilterMode("any")}
                      type="button"
                      data-tooltip="Any: show images that match at least one selected label."
                      aria-label="Any: show images that match at least one selected label."
                    >
                      Any
                    </button>
                    <button
                      className={`btn small filter-mode-tooltip ${
                        filterMode === "all" ? "primary" : "ghost"
                      }`}
                      onClick={() => setFilterMode("all")}
                      type="button"
                      data-tooltip="All: show images that match each selected category (at least one selected label per category)."
                      aria-label="All: show images that match each selected category (at least one selected label per category)."
                    >
                      All
                    </button>
                    <button
                      className="btn ghost small"
                      onClick={clearFilterLabels}
                      disabled={filterUseExportSelection}
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
                              checked={filterLabelKeys.has(
                                buildLabelKey(category.name, label.name)
                              )}
                              onChange={(event) =>
                                toggleFilterLabel(
                                  buildLabelKey(category.name, label.name),
                                  event.target.checked
                                )
                              }
                              disabled={filterUseExportSelection}
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
            <div className="unlabeled-toggle">
              <button
                className={`btn ghost toggle unlabeled-trigger${
                  unlabeledCategoryIds.size ? " active" : ""
                }`}
                onClick={() => setUnlabeledOpen((prev) => !prev)}
                type="button"
                aria-expanded={unlabeledOpen}
                aria-label="Unlabeled"
              >
                <span
                  className={`unlabeled-dot${
                    unlabeledCategoryIds.size ? " active" : ""
                  }`}
                  aria-hidden="true"
                />
                <span>Unlabeled</span>
                {unlabeledCategoryIds.size ? (
                  <span className="unlabeled-count">
                    ({unlabeledCategoryIds.size})
                  </span>
                ) : null}
              </button>
              {unlabeledOpen && (
                <div className="filter-dropdown unlabeled-dropdown">
                  <div className="filter-dropdown-header">
                    <div className="filter-dropdown-title">
                      Unlabeled Categories
                    </div>
                    <button
                      className="filter-close"
                      onClick={() => setUnlabeledOpen(false)}
                      type="button"
                      aria-label="Close unlabeled categories"
                    >
                      x
                    </button>
                  </div>
                  <div className="filter-note subtle">
                    Show images that are missing labels in selected categories.
                  </div>
                  <div className="unlabeled-actions">
                    <button
                      className="btn ghost small"
                      onClick={clearUnlabeledCategories}
                      disabled={!unlabeledCategoryIds.size}
                      type="button"
                    >
                      Clear
                    </button>
                  </div>
                  {categories.length ? (
                    <div className="unlabeled-categories">
                      {categories.map((category) => (
                        <label key={category.id} className="checkbox">
                          <input
                            type="checkbox"
                            checked={unlabeledCategoryIds.has(category.id)}
                            onChange={(event) =>
                              toggleUnlabeledCategory(
                                category.id,
                                event.target.checked
                              )
                            }
                          />
                          <span>
                            {category.name} (
                            {unlabeledCategoryCounts.get(category.id) || 0})
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <div className="subtle">
                      Add categories first to use unlabeled-by-category
                      filtering.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="actions-group actions-right">
            <button
              className="btn ghost"
              onClick={handleExport}
              disabled={!exportProjectIds.size || exporting}
              type="button"
            >
              {exporting
                ? "Preparing preview..."
                : `Preview CSV${exportProjectIds.size > 1 ? " (" + exportProjectIds.size + ")" : ""}`}
            </button>
          </div>
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
            {hasActiveFilter ? (
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
          ) : showFilteredEmpty ? (
            <div className="empty-viewer">
              <div className="empty-title">No matches</div>
              <div className="subtle">
                No images match the current filters. Adjust the filter
                selection, turn off <strong>Filter active</strong>, or toggle
                off unlabeled category selections.
              </div>
            </div>
          ) : currentItem ? (
            <>
              <div className="viewer-top">
                <div>
                  <div className="filename">{currentItem.rel_path}</div>
                  <div className="subtle">
                    Use 1-9 for labels in the active category, Shift+1-9 to
                    add/remove, arrows to navigate, X to clear.
                  </div>
                </div>
                <div className="viewer-actions">
                  <button
                    className="btn danger"
                    onClick={handleDeleteImage}
                    disabled={deletingImage}
                    type="button"
                  >
                    {deletingImage ? "Deleting..." : "Delete Image"}
                  </button>
                </div>
              </div>

              <div className="image-shell">
                <img
                  src={currentItem.thumbnail_url}
                  alt={currentItem.filename}
                />
              </div>

              <div className="nav-row nav-row-icons">
                <button
                  className="nav-icon"
                  onClick={goPrev}
                  disabled={currentIndex <= 0}
                  type="button"
                  title="Previous"
                  data-label="Previous"
                  aria-label="Previous"
                >
                  ◀
                </button>
                <button
                  className="nav-icon"
                  onClick={skip}
                  disabled={currentIndex >= images.length - 1}
                  type="button"
                  title="Skip"
                  data-label="Skip"
                  aria-label="Skip"
                >
                  ⏭
                </button>
                <button
                  className="nav-icon"
                  onClick={goNext}
                  disabled={currentIndex >= images.length - 1}
                  type="button"
                  title="Next"
                  data-label="Next"
                  aria-label="Next"
                >
                  ▶
                </button>
              </div>

              {filteredIndexes.length > 0 ? (
                <div className="preview-section">
                <div className="preview-header">
                    <div className="section-title-row">
                      <div className="section-title">Image Previews</div>
                      <button
                        className={`collapse-icon${
                          previewCollapsed ? " collapsed" : ""
                        }`}
                        onClick={() => setPreviewCollapsed((prev) => !prev)}
                        type="button"
                        aria-expanded={!previewCollapsed}
                        aria-label={
                          previewCollapsed
                            ? "Expand image previews"
                            : "Collapse image previews"
                        }
                        title={
                          previewCollapsed
                            ? "Expand image previews"
                            : "Collapse image previews"
                        }
                      >
                        ⌄
                      </button>
                    </div>
                  </div>
                  {!previewCollapsed ? (
                    <div className="preview-strip">
                      {filteredIndexes.map((index) => {
                        const item = images[index];
                        const active = index === currentIndex;
                        const isLabeled = Object.keys(item.labels).length > 0;
                        return (
                          <button
                            key={item.rel_path}
                            className={`preview-thumb ${
                              active ? "active" : ""
                            }`}
                            onClick={() => setCurrentIndex(index)}
                            type="button"
                          >
                            <img
                              src={item.thumbnail_url}
                              alt={item.filename}
                              loading="lazy"
                            />
                            <span
                              className={`thumb-overlay ${
                                isLabeled ? "labeled" : ""
                              }`}
                              aria-hidden="true"
                            >
                              <span className="thumb-overlay-label">
                                labeled
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="label-panel">
                {labelPanelCategories.map((category) => {
                  const active = category.id === activeCategoryId;
                  const current = currentLabels(category.id);
                  return (
                    <div
                      key={category.id}
                      className={`category-block ${active ? "active" : ""}`}
                      onClick={() => {
                        setActiveCategoryId(category.id);
                        setActiveCategoryName(category.name);
                      }}
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
                          disabled={current.length === 0}
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
                              current.some(
                                (selected) =>
                                  selected.label_option_id === label.id
                              )
                                ? "active"
                                : ""
                            }`}
                            onClick={(event) => {
                              event.stopPropagation();
                              const toggle = event.shiftKey;
                              applyLabel(category.id, label.id, {
                                mode: toggle ? "toggle" : "replace",
                                advance: !toggle,
                              });
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
                <div className="section-header">
                  <div className="section-title-row">
                    <div className="section-title">
                      Manage Categories & Labels
                    </div>
                    <button
                      className={`collapse-icon${
                        manageCollapsed ? " collapsed" : ""
                      }`}
                      onClick={() => setManageCollapsed((prev) => !prev)}
                      type="button"
                      aria-expanded={!manageCollapsed}
                      aria-label={
                        manageCollapsed
                          ? "Expand manage categories"
                          : "Collapse manage categories"
                      }
                      title={
                        manageCollapsed
                          ? "Expand manage categories"
                          : "Collapse manage categories"
                      }
                    >
                      ⌄
                    </button>
                  </div>
                  <div className="label-actions">
                    <button
                      className="btn ghost small"
                      onClick={handleOpenSchemaExplorer}
                      disabled={selectedProjectId === null}
                      type="button"
                    >
                      Explore Schemas
                    </button>
                  </div>
                </div>
                {schemaExplorerOpen ? (
                  <div className="schema-explorer">
                    <div className="schema-explorer-header">
                      <div className="schema-explorer-title">
                        Explore Existing Schemas
                      </div>
                      <div className="label-actions">
                        <button
                          className="btn ghost small"
                          onClick={() => void loadSchemaExplorer()}
                          disabled={schemaExplorerLoading}
                          type="button"
                        >
                          Refresh
                        </button>
                        <button
                          className="btn ghost small"
                          onClick={() => setSchemaExplorerOpen(false)}
                          type="button"
                        >
                          Close
                        </button>
                      </div>
                    </div>
                    <div className="subtle">
                      Green means items will be added. Red means items will be removed.
                    </div>
                    {schemaExplorerLoading ? (
                      <div className="subtle">Loading schemas...</div>
                    ) : schemaExplorerError ? (
                      <div className="error-banner">{schemaExplorerError}</div>
                    ) : schemaExplorerGroups.length ? (
                      <div className="schema-group-list">
                        {schemaExplorerGroups.map((group) => {
                          const diff = schemaDiffBySignature.get(group.signature);
                          return (
                            <div key={group.signature} className="schema-group-card">
                              <div className="schema-group-header">
                                <div>
                                  <div className="schema-group-projects">
                                    {group.projectNames.join(", ")}
                                  </div>
                                  <div className="subtle">
                                    {group.projectNames.length > 1
                                      ? `${group.projectNames.length} projects share this schema`
                                      : "1 project has this schema"}
                                  </div>
                                  {diff ? (
                                    <div className="schema-group-badges">
                                      {!diff.hasChanges ? (
                                        <span className="schema-badge neutral">
                                          No changes
                                        </span>
                                      ) : (
                                        <>
                                          {diff.addedCategories > 0 ? (
                                            <span className="schema-badge added">
                                              +{diff.addedCategories} categories
                                            </span>
                                          ) : null}
                                          {diff.addedLabels > 0 ? (
                                            <span className="schema-badge added">
                                              +{diff.addedLabels} labels
                                            </span>
                                          ) : null}
                                          {diff.removedCategories > 0 ? (
                                            <span className="schema-badge removed">
                                              -{diff.removedCategories} categories
                                            </span>
                                          ) : null}
                                          {diff.removedLabels > 0 ? (
                                            <span className="schema-badge removed">
                                              -{diff.removedLabels} labels
                                            </span>
                                          ) : null}
                                        </>
                                      )}
                                    </div>
                                  ) : null}
                                </div>
                                <button
                                  className="btn small"
                                  onClick={() => void handleApplySchemaGroup(group)}
                                  disabled={
                                    schemaApplyingSignature === group.signature ||
                                    (diff ? !diff.hasChanges : false)
                                  }
                                  type="button"
                                >
                                  {schemaApplyingSignature === group.signature
                                    ? "Applying..."
                                    : diff && !diff.hasChanges
                                      ? "Up to date"
                                      : "Use Schema"}
                                </button>
                              </div>
                              <div className="schema-group-categories">
                                {(diff?.categories || []).map((categoryDiff) => {
                                  const status = categoryDiff.status;
                                  const categoryLabelTone =
                                    status === "added"
                                      ? "added"
                                      : status === "removed"
                                        ? "removed"
                                        : "same";
                                  return (
                                    <div
                                      key={`${group.signature}-${categoryDiff.name}-${status}`}
                                      className={`schema-group-category ${status}`}
                                    >
                                      <div className="schema-group-category-head">
                                        <div className={`schema-group-category-name ${status}`}>
                                          {categoryDiff.name}
                                        </div>
                                        <span className={`schema-mini-badge ${status}`}>
                                          {status === "added"
                                            ? "New"
                                            : status === "removed"
                                              ? "Removed"
                                            : status === "changed"
                                              ? "Changed"
                                              : "Same"}
                                        </span>
                                      </div>
                                      {status === "changed" ? (
                                        <div className="schema-diff-lines">
                                          {categoryDiff.addedLabels.length > 0 ? (
                                            <div className="schema-diff-line added">
                                              <span className="schema-diff-prefix">
                                                Adds:
                                              </span>
                                              <div className="schema-label-list">
                                                {categoryDiff.addedLabels.map((label) => (
                                                  <span
                                                    key={`${group.signature}-${categoryDiff.name}-add-${label}`}
                                                    className="schema-label-chip added"
                                                  >
                                                    {label}
                                                  </span>
                                                ))}
                                              </div>
                                            </div>
                                          ) : null}
                                          {categoryDiff.removedLabels.length > 0 ? (
                                            <div className="schema-diff-line removed">
                                              <span className="schema-diff-prefix">
                                                Removes:
                                              </span>
                                              <div className="schema-label-list">
                                                {categoryDiff.removedLabels.map((label) => (
                                                  <span
                                                    key={`${group.signature}-${categoryDiff.name}-remove-${label}`}
                                                    className="schema-label-chip removed"
                                                  >
                                                    {label}
                                                  </span>
                                                ))}
                                              </div>
                                            </div>
                                          ) : null}
                                          {!categoryDiff.addedLabels.length &&
                                          !categoryDiff.removedLabels.length ? (
                                            <div className="subtle">No label changes</div>
                                          ) : null}
                                        </div>
                                      ) : (
                                        <div
                                          className={
                                            status === "added"
                                              ? "schema-diff-line added"
                                              : status === "removed"
                                                ? "schema-diff-line removed"
                                                : "schema-diff-line same"
                                          }
                                        >
                                          <div className="schema-label-list">
                                            {categoryDiff.labels.length ? (
                                              categoryDiff.labels.map((label) => (
                                                <span
                                                  key={`${group.signature}-${categoryDiff.name}-${status}-${label}`}
                                                  className={`schema-label-chip ${categoryLabelTone}`}
                                                >
                                                  {label}
                                                </span>
                                              ))
                                            ) : (
                                              <span className="schema-label-chip empty">
                                                No labels
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="subtle">
                        No reusable schemas found in other projects.
                      </div>
                    )}
                  </div>
                ) : null}
                {!manageCollapsed
                  ? categories.map((category) => (
                      <div
                        key={category.id}
                        className={`manage-category${
                          draggingCategoryId === category.id ? " dragging" : ""
                        }${
                          dragOverCategoryId === category.id ? " drag-over" : ""
                        }`}
                        onDragOver={handleCategoryDragOver}
                        onDragEnter={() =>
                          handleCategoryDragEnter(category.id)
                        }
                        onDrop={(event) =>
                          handleCategoryDrop(event, category.id)
                        }
                      >
                        <div
                          className="manage-category-header"
                          draggable
                          onDragStart={(event) =>
                            handleCategoryDragStart(event, category.id)
                          }
                          onDragEnd={handleCategoryDragEnd}
                          title="Drag to reorder categories"
                        >
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
                                  onClick={() =>
                                    handleDeleteCategory(category.id)
                                  }
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
                    ))
                  : null}
              </div>

              <div className="export-panel">
                <div className="export-projects">
                  <div className="export-projects-header">
                    <div className="section-title-row">
                      <div className="section-title">Export Projects</div>
                      <button
                        className={`collapse-icon${
                          exportProjectsCollapsed ? " collapsed" : ""
                        }`}
                        onClick={() =>
                          setExportProjectsCollapsed((prev) => !prev)
                        }
                        type="button"
                        aria-expanded={!exportProjectsCollapsed}
                        aria-label={
                          exportProjectsCollapsed
                            ? "Expand export projects"
                            : "Collapse export projects"
                        }
                        title={
                          exportProjectsCollapsed
                            ? "Expand export projects"
                            : "Collapse export projects"
                        }
                      >
                        ⌄
                      </button>
                    </div>
                    <div className="label-actions">
                      <button
                        className="btn ghost small"
                        onClick={selectAllExportProjects}
                        type="button"
                      >
                        Select All
                      </button>
                      <button
                        className="btn ghost small"
                        onClick={useCurrentProjectForExport}
                        type="button"
                      >
                        Use Current
                      </button>
                    </div>
                  </div>
                  {!exportProjectsCollapsed ? (
                    <div className="export-project-list">
                      {projects.map((project) => (
                        <label
                          key={project.id}
                          className="checkbox export-project"
                        >
                          <input
                            type="checkbox"
                            checked={exportProjectIds.has(project.id)}
                            onChange={() => toggleExportProject(project.id)}
                          />
                          <span>{project.name}</span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="export-header">
                  <div className="section-title-row">
                    <div className="section-title">Export Selection</div>
                    <button
                      className={`collapse-icon${
                        exportSelectionCollapsed ? " collapsed" : ""
                      }`}
                      onClick={() =>
                        setExportSelectionCollapsed((prev) => !prev)
                      }
                      type="button"
                      aria-expanded={!exportSelectionCollapsed}
                      aria-label={
                        exportSelectionCollapsed
                          ? "Expand export selection"
                          : "Collapse export selection"
                      }
                      title={
                        exportSelectionCollapsed
                          ? "Expand export selection"
                          : "Collapse export selection"
                      }
                    >
                      ⌄
                    </button>
                  </div>
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
                {!exportSelectionCollapsed ? (
                  <>
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
                    <label className="checkbox export-toggle">
                      <input
                        type="checkbox"
                        checked={filterUseExportSelection}
                        onChange={(event) =>
                          handleFilterUseExportSelection(event.target.checked)
                        }
                      />
                      <span>Only show images that match selected labels</span>
                    </label>
                    {categories.map((category) => (
                      <div key={category.id} className="export-category">
                        <div className="export-category-name">
                          {`${category.name} (${
                            exportCounts.categoryCounts.get(category.name) || 0
                          })`}
                        </div>
                        <div className="export-labels">
                          {category.labels.map((label) => (
                            <label key={label.id} className="checkbox">
                              <input
                                type="checkbox"
                                checked={exportLabelKeys.has(
                                  buildLabelKey(category.name, label.name)
                                )}
                                onChange={() =>
                                  toggleLabelSelection(
                                    buildLabelKey(category.name, label.name)
                                  )
                                }
                              />
                              <span>
                                {`${label.name} (${
                                  exportCounts.labelCounts.get(
                                    buildLabelKey(category.name, label.name)
                                  ) || 0
                                })`}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </>
                ) : null}
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
