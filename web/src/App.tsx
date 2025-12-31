import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const LABELS = ["Usable", "Too Blurry", "Wrong Setup", "Irrelevant"];
const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];

type ImageItem = {
  id: string;
  name: string;
  file: File;
  url: string;
};

const isSupported = (file: File) => {
  const lower = file.name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

const toDisplayName = (file: File) =>
  (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

const escapeCsv = (value: string) => {
  const escaped = value.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
};

const buildCsv = (items: ImageItem[], labelsMap: Record<string, string>) => {
  const rows = items
    .map((item) => ({
      name: item.name,
      label: labelsMap[item.name] || "",
    }))
    .filter((row) => row.label);

  const lines = [
    "filename,label",
    ...rows.map((row) => `${escapeCsv(row.name)},${escapeCsv(row.label)}`),
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

const App: React.FC = () => {
  const [items, setItems] = useState<ImageItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [labelsMap, setLabelsMap] = useState<Record<string, string>>({});

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef<ImageItem[]>([]);

  useEffect(() => {
    if (!fileInputRef.current) return;
    fileInputRef.current.setAttribute("webkitdirectory", "");
    fileInputRef.current.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    return () => {
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, []);

  const currentItem = items[currentIndex] || null;
  const currentLabel = currentItem ? labelsMap[currentItem.name] || "" : "";

  const labeledCount = Object.keys(labelsMap).length;
  const progressPercent = items.length ? Math.round((labeledCount / items.length) * 100) : 0;

  const handleFilesChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const list = event.target.files;
      if (!list) return;

      const files = Array.from(list).filter(isSupported);
      if (!files.length) {
        setItems([]);
        setLabelsMap({});
        setCurrentIndex(0);
        return;
      }

      items.forEach((item) => URL.revokeObjectURL(item.url));

      const nextItems = files.map((file, index) => {
        const url = URL.createObjectURL(file);
        const name = toDisplayName(file);
        return {
          id: `${name}-${file.lastModified}-${index}`,
          name,
          file,
          url,
        } satisfies ImageItem;
      });

      setItems(nextItems);
      setLabelsMap({});
      setCurrentIndex(0);
    },
    [items]
  );

  const applyLabel = useCallback(
    (label: string) => {
      if (!currentItem) return;

      setLabelsMap((prev) => ({ ...prev, [currentItem.name]: label }));

      if (currentIndex < items.length - 1) {
        setCurrentIndex((prev) => Math.min(prev + 1, items.length - 1));
      }
    },
    [currentIndex, currentItem, items.length]
  );

  const clearLabel = useCallback(() => {
    if (!currentItem) return;
    setLabelsMap((prev) => {
      const next = { ...prev };
      delete next[currentItem.name];
      return next;
    });
  }, [currentItem]);

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => Math.min(prev + 1, items.length - 1));
  }, [items.length]);

  const skip = useCallback(() => {
    if (currentIndex < items.length - 1) {
      setCurrentIndex((prev) => Math.min(prev + 1, items.length - 1));
    }
  }, [currentIndex, items.length]);

  const handleExport = useCallback(() => {
    if (!items.length) return;
    const csv = buildCsv(items, labelsMap);
    downloadText("labels.csv", csv);
  }, [items, labelsMap]);

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
        if (LABELS[index]) {
          event.preventDefault();
          applyLabel(LABELS[index]);
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
  }, [applyLabel, clearLabel, currentLabel, goNext, goPrev]);

  const sidebarList = useMemo(() => {
    if (!items.length) return null;
    return items.map((item, index) => {
      const label = labelsMap[item.name] || "";
      return (
        <button
          key={item.id}
          className={`list-item ${index === currentIndex ? "active" : ""}`}
          onClick={() => setCurrentIndex(index)}
          type="button"
        >
          <span className="list-name">{item.name}</span>
          <span className={`pill ${label ? "pill-filled" : "pill-empty"}`}>
            {label || "Unlabeled"}
          </span>
        </button>
      );
    });
  }, [currentIndex, items, labelsMap]);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="brand">Labeling Studio</div>
          <div className="subtle">Lean React build for fast image labeling</div>
        </div>
        <div className="actions">
          <label className="btn primary file-button">
            Select Folder
            <input
              ref={fileInputRef}
              type="file"
              accept={SUPPORTED_EXTENSIONS.join(",")}
              multiple
              onChange={handleFilesChange}
            />
          </label>
          <button className="btn ghost" onClick={handleExport} disabled={!labeledCount} type="button">
            Export CSV
          </button>
        </div>
      </header>

      <div className="content">
        <aside className="card sidebar">
          <div className="sidebar-header">
            <div>
              <div className="section-title">Project</div>
              <div className="subtle">{items.length ? "Local folder" : "No folder loaded"}</div>
            </div>
            <div className="stat">{items.length} imgs</div>
          </div>

          <div className="progress">
            <div className="progress-row">
              <span>{items.length ? `Image ${currentIndex + 1} of ${items.length}` : "No images"}</span>
              <span>{labeledCount} labeled</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>

          <div className="list">
            {items.length ? (
              sidebarList
            ) : (
              <div className="empty-list">
                <div className="empty-icon">+</div>
                <div className="empty-title">Drop in a folder of images</div>
                <div className="subtle">Chrome / Edge recommended for folder pickers.</div>
              </div>
            )}
          </div>
        </aside>

        <main className="card viewer">
          {currentItem ? (
            <>
              <div className="viewer-top">
                <div>
                  <div className="filename">{currentItem.name}</div>
                  <div className="subtle">Use 1-4 to label, arrows to navigate, X to clear.</div>
                </div>
                <div className={`pill ${currentLabel ? "pill-filled" : "pill-empty"}`}>
                  {currentLabel || "Unlabeled"}
                </div>
              </div>

              <div className="image-shell">
                <img src={currentItem.url} alt={currentItem.name} />
              </div>

              <div className="label-row">
                {LABELS.map((label, index) => (
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

              <div className="nav-row">
                <button className="btn" onClick={goPrev} disabled={currentIndex <= 0} type="button">
                  Prev
                </button>
                <button className="btn ghost" onClick={skip} disabled={currentIndex >= items.length - 1} type="button">
                  Skip
                </button>
                <button className="btn" onClick={goNext} disabled={currentIndex >= items.length - 1} type="button">
                  Next
                </button>
              </div>
            </>
          ) : (
            <div className="empty-viewer">
              <div className="empty-title">No images loaded</div>
              <div className="subtle">
                Select a folder of images to start labeling. The app supports JPG, PNG, GIF, BMP, and WebP.
              </div>
              <div className="empty-hint">
                Tip: Use number keys 1-4 for labels and arrow keys to navigate.
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
