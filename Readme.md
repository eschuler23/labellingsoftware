# Labelingsoftware

A stateful React image labeling tool with folder uploads, keyboard shortcuts, custom labels, and CSV export.

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
- Use number keys **1-9** or click label buttons to tag images.
- Add, rename, or delete labels in the **Manage Labels** section.
- Navigate with **arrow keys**, or use **Prev / Next / Skip**.
- Click **Export CSV** to download `labels.csv` (`filename,label`).

### Notes

- Folder selection uses the browser directory picker (via `webkitdirectory`).
- Supported formats: JPG, PNG, GIF, BMP, WebP.
