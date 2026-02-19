# Labelingsoftware

React + FastAPI image labeling tool with multi-category labels, keyboard shortcuts, filtering, and CSV preview/export.

## Quick Start (Recommended)

Run everything from the repo root:

```bash
cd /path/to/labelling
./run_labelling.sh
```

This script:
- creates `.venv` if needed,
- installs backend dependencies,
- starts FastAPI on `http://localhost:8000`,
- starts the frontend on `http://localhost:5173`.

Stop both with `Ctrl+C`.

## Manual Start (Optional)

Backend:

```bash
cd /path/to/labelling
.venv/bin/python -m uvicorn server.app:app --reload --host 127.0.0.1 --port 8000
```

Frontend:

```bash
cd /path/to/labelling/web
npm install
npm run dev
```

## Usage

- Click **Upload Folder** to import a local directory of images (each folder becomes a project).
- New projects start with no categories/labels; create your own schema or reuse one.
- In **Manage Categories & Labels**, use **Explore Schemas** to reuse schemas from other projects.
- Create label categories and labels, then label images per category.
- Keyboard shortcuts:
  - `1-9`: apply label in active category
  - `Shift+1-9`: toggle label in active category
  - `←` / `→`: previous/next image
  - `X`: clear labels in active category
- **Filter** button:
  - toggle filter active on/off,
  - choose `Any` or `All`,
  - optionally use export selection as filter source.
- **Unlabeled** button:
  - select categories to show images missing labels in those categories,
  - selecting a category there also activates that category for hotkeys.
- **Preview CSV** opens a preview tab where you can inspect rows, edit filename, and click **Download CSV**.
  - If nothing opens, allow popups for localhost.

## Data & Storage

- SQLite DB: `data/labeling.db`
- Uploaded files: `uploads/`
- Supported image formats: JPG, JPEG, PNG, GIF, BMP, WebP
