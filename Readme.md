# Labelingsoftware

A stateful React image labeling tool with folder uploads, keyboard shortcuts, multi-category labels, and CSV export.

## React app

### Run locally (frontend)

```bash
cd web
npm install
npm run dev
```

### Backend (FastAPI + SQLite)

```bash
# from repo root
pip install fastapi uvicorn watchdog
uvicorn server.app:app --reload
```

- The backend stores project state in `data/labeling.db`.
- Uploaded files are stored under `uploads/`.
- The backend watches `uploads/` for new files and you can click **Refresh** to pull new items into the UI.

### Usage

- Click **Upload Folder** to load a local folder of images.
- Each folder becomes a project in the sidebar (upload multiple folders anytime).
- Create **label categories** (e.g. “Focus”, “Content type”). Each category can have multiple labels.
- Assign labels per category; an image can have multiple labels across categories.
- Use number keys **1-9** for the active category, arrows to navigate, **X** to clear that category.
- Filter previews by label selection (match any/all).
- Use **Export Selection** to choose which labels are included in the CSV export.
- (Optional) Export only images that match selected labels.
- Click **Export CSV** to download `labels.csv` (`filename` + selected category columns).

### Notes

- Folder selection uses the browser directory picker (via `webkitdirectory`).
- Supported formats: JPG, PNG, GIF, BMP, WebP.
