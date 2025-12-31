# Labelingsoftware

A modern React image labeling tool with folder upload, keyboard shortcuts, and CSV export.

## React app

This is a lightweight React implementation that avoids heavy annotation dependencies.

### Run locally

```bash
cd web
npm install
npm run dev
```

### Usage

- Click **Select Folder** to load a local folder of images (Chrome / Edge recommended).
- Use number keys **1-4** or click the label buttons to tag images.
- Navigate with **arrow keys**, or use **Prev / Next / Skip**.
- Click **Export CSV** to download `labels.csv` (`filename,label`).

### Notes

- Folder selection uses the browser directory picker (via `webkitdirectory`).
- Supported formats: JPG, PNG, GIF, BMP, WebP.

## Legacy implementations

- `main.py` contains the original Tkinter app.
- `labellingsoftware/` contains the prior Reflex web app.

Both are kept for reference while the React rewrite takes over.
