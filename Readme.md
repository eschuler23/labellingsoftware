# Labelingsoftware

React + FastAPI image labeling tool with multi-category labels, keyboard shortcuts, filtering, and CSV preview/export.

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

## Screenshots

<p align="center">

| | |
|---|---|
| <img src="https://github.com/user-attachments/assets/740e6a58-e7c5-4eed-b218-404fd9dab7c1" width="450"/> | <img src="https://github.com/user-attachments/assets/f3222603-6fa8-45a5-a21c-1a39601e89a1" width="450"/> |
| <img src="https://github.com/user-attachments/assets/de0a6468-4ec3-42dd-bef2-9bb900996c50" width="450"/> | <img src="https://github.com/user-attachments/assets/05a296a3-7622-4a98-aa14-920d3c5121af" width="450"/> |

</p>

## Data & Storage

- SQLite DB: `data/labeling.db`
- Uploaded files: `uploads/`
- Supported image formats: JPG, JPEG, PNG, GIF, BMP, WebP
- In Docker mode, data lives in named volumes: `labelling_data` and `labelling_uploads`.

## Setup

### Quick Start (Local Dev)

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

### Docker (Single Container)

Make sure Docker Desktop (or Docker daemon) is running first.

Build the image:

```bash
cd /path/to/labelling
docker build -t labellingsoftware:local .
```

Run it with persistent local volumes:

```bash
docker run --rm \
  -p 127.0.0.1:8001:8000 \
  -v labelling_data:/app/data \
  -v labelling_uploads:/app/uploads \
  labellingsoftware:local
```

Or use Compose:

```bash
cd /path/to/labelling
HOST_PORT=8001 docker compose up --build
```

Then open: `http://localhost:8001`

### Manual Start (Optional)

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

### Lab Sync (Multiple Laptops)

approach for synchronization:
- run one central container on one machine/server,
- let all laptops connect to that one instance,
- keep one shared DB and upload store inside that container's volumes.
- no central user management is required (all users share the same project state on that server).

Start compose in network mode on the host machine:

```bash
cd /path/to/labelling
HOST_BIND=0.0.0.0 HOST_PORT=8000 docker compose up --build -d
```

Then teammates open `http://<host-machine-ip>:8000`.

Important: do not run multiple backend containers against the same SQLite file. For one shared backend process, SQLite is fine.

### HTTPS Lab Mode (Optional)

If you want HTTPS, run compose with the HTTPS override (Caddy reverse proxy):

```bash
cd /path/to/labelling
LABELLING_HTTPS_HOST=localhost HTTPS_HOST_BIND=127.0.0.1 HTTPS_PORT=8443 HOST_PORT=18000 \
  docker compose -f docker-compose.yml -f docker-compose.https.yml up --build -d
```

Open: `https://localhost:8443`

For shared lab usage (multiple laptops), run on the host machine with its LAN IP:

```bash
cd /path/to/labelling
LABELLING_HTTPS_HOST=<host-machine-ip> HTTPS_HOST_BIND=0.0.0.0 HTTPS_PORT=8443 HOST_PORT=18000 \
  docker compose -f docker-compose.yml -f docker-compose.https.yml up --build -d
```

Teammates then open: `https://<host-machine-ip>:8443`

#### Remove Browser "Not Secure" Warning

Caddy uses a local internal CA in this mode. To remove warnings, trust that CA on each client machine.

Export the CA certificate from the host:

```bash
cd /path/to/labelling
docker compose -f docker-compose.yml -f docker-compose.https.yml exec caddy \
  sh -lc 'cat /data/caddy/pki/authorities/local/root.crt' > caddy-local-root.crt
```

macOS trust command (run on each laptop, admin required):

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain caddy-local-root.crt
```

After trusting the cert, reload the HTTPS page.

## Collaboration

This project is actively maintained.

If you want a new feature, please open a GitHub issue:
- https://github.com/eschuler23/labellingsoftware/issues

When possible, include:
- what problem you want to solve,
- the exact workflow you have in mind,
- screenshots or mockups,
- why current behavior is not enough.

For contribution terms, see:
- `CONTRIBUTING.md`

## License

This project uses dual licensing:
- Default public license: PolyForm Noncommercial 1.0.0 (`LICENSE`, `LICENSES/PolyForm-Noncommercial-1.0.0.md`)
- Commercial use: requires a separate paid commercial license (`COMMERCIAL-LICENSE.md`)

What this means in practice:
- Students, researchers, and other noncommercial users can clone and use it under the noncommercial terms.
- Companies and other commercial users must reach out for a commercial license.
