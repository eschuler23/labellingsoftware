# Labelingsoftware

React + FastAPI image labeling tool with multi-category labels, keyboard shortcuts, filtering, and CSV preview/export.

## Quick Start (Local Dev)

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

## Docker (Single Container)

Make sure Docker Desktop (or Docker daemon) is running first.

Build the image:

```bash
cd /path/to/labelling
docker build -t labellingsoftware:local .
```

Run it with persistent local volumes:

```bash
docker run --rm \
  -p 127.0.0.1:8000:8000 \
  -v labelling_data:/app/data \
  -v labelling_uploads:/app/uploads \
  labellingsoftware:local
```

Or use Compose:

```bash
cd /path/to/labelling
docker compose up --build
```

Then open: `http://localhost:8000`

## Lab Sync (Multiple Laptops)

Yes, network mode is the right approach for synchronization:
- run one central container on one machine/server,
- let all laptops connect to that one instance,
- keep one shared DB and upload store inside that container's volumes.
- no central user management is required (all users share the same project state on that server).

Start compose in network mode on the host machine:

```bash
cd /path/to/labelling
HOST_BIND=0.0.0.0 docker compose up --build -d
```

Then teammates open `http://<host-machine-ip>:8000`.

Important: do not run multiple backend containers against the same SQLite file. For one shared backend process, SQLite is fine.

## Docker Hub Notes

- Docker Hub is optional and mainly useful to distribute the app image faster.
- The pushed image contains application code/runtime, not your local `uploads` or `data`.
- Your images/DB stay private on your machine unless you explicitly copy/share volumes.
- Local-only mode remains the default with compose (`127.0.0.1` bind).

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
- In Docker mode, data lives in named volumes: `labelling_data` and `labelling_uploads`.
