from __future__ import annotations

import shutil
import urllib.parse
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .db import (
    UPLOADS_DIR,
    add_images,
    add_label_option,
    create_project,
    get_project,
    init_db,
    list_images,
    list_label_options,
    list_projects,
    set_label,
    update_project_index,
)
from .watchers import SUPPORTED_EXTENSIONS, UploadWatcher

app = FastAPI(title="Labeling Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

watcher = UploadWatcher()


class LabelUpdate(BaseModel):
    rel_path: str
    label: str | None = None


class PositionUpdate(BaseModel):
    index: int


def sanitize_rel_path(raw: str) -> str:
    path = Path(raw)
    if path.is_absolute():
        raise HTTPException(status_code=400, detail="Invalid path")
    if any(part in ("..", "") for part in path.parts):
        raise HTTPException(status_code=400, detail="Invalid path")
    return path.as_posix()


def ensure_project(project_id: int) -> dict:
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def project_dir(project: dict) -> Path:
    return UPLOADS_DIR / project["storage_dir"]


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    watcher.start()
    for project in list_projects(include_storage_dir=True):
        watcher.watch_project(project["id"], UPLOADS_DIR / project["storage_dir"])


@app.on_event("shutdown")
def on_shutdown() -> None:
    watcher.stop()


@app.get("/api/projects")
def api_list_projects() -> dict[str, Any]:
    return {"projects": list_projects(include_storage_dir=False)}


@app.post("/api/projects/upload")
async def api_upload_project(
    files: list[UploadFile] = File(...),
    project_name: str | None = Form(default=None),
) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    first_name = files[0].filename or ""
    root_guess = Path(first_name).parts[0] if first_name else "Uploads"
    name = (project_name or root_guess or "Uploads").strip() or "Uploads"

    project = create_project(name)
    storage_dir = project_dir(project)
    storage_dir.mkdir(parents=True, exist_ok=True)

    collected: list[tuple[str, str]] = []

    for upload in files:
        raw_name = upload.filename or ""
        if not raw_name:
            continue
        rel_path = sanitize_rel_path(raw_name)
        if rel_path.startswith(f"{root_guess}/"):
            rel_path = rel_path[len(root_guess) + 1 :]
        if not rel_path:
            continue

        if Path(rel_path).suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue

        dest = storage_dir / rel_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as f:
            shutil.copyfileobj(upload.file, f)

        collected.append((rel_path, Path(rel_path).name))

    if collected:
        add_images(project["id"], collected)

    watcher.watch_project(project["id"], storage_dir)

    return {"project": project}


@app.get("/api/projects/{project_id}/images")
def api_list_images(project_id: int) -> dict[str, Any]:
    project = ensure_project(project_id)
    images = list_images(project_id)
    output = []
    for item in images:
        rel_path = item["rel_path"]
        url = f"/api/projects/{project_id}/image?path={urllib.parse.quote(rel_path, safe='')}"
        output.append(
            {
                "rel_path": rel_path,
                "filename": item["filename"],
                "label": item.get("label") or "",
                "url": url,
            }
        )
    return {"images": output, "last_index": project["last_index"]}


@app.get("/api/projects/{project_id}/image")
def api_get_image(project_id: int, path: str) -> FileResponse:
    project = ensure_project(project_id)
    rel_path = sanitize_rel_path(urllib.parse.unquote(path))
    storage_dir = project_dir(project)
    full_path = (storage_dir / rel_path).resolve()
    root_path = storage_dir.resolve()
    if not full_path.is_file() or not full_path.is_relative_to(root_path):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(full_path)


@app.get("/api/projects/{project_id}/label-options")
def api_label_options(project_id: int) -> dict[str, Any]:
    ensure_project(project_id)
    return {"labels": list_label_options(project_id)}


@app.post("/api/projects/{project_id}/label-options")
def api_add_label_option(project_id: int, payload: dict[str, str]) -> dict[str, Any]:
    ensure_project(project_id)
    name = payload.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Label name required")
    labels = add_label_option(project_id, name)
    return {"labels": labels}


@app.post("/api/projects/{project_id}/labels")
def api_set_label(project_id: int, payload: LabelUpdate) -> dict[str, Any]:
    ensure_project(project_id)
    rel_path = sanitize_rel_path(payload.rel_path)
    label = (payload.label or "").strip()
    set_label(project_id, rel_path, label if label else None)
    return {"ok": True}


@app.post("/api/projects/{project_id}/position")
def api_set_position(project_id: int, payload: PositionUpdate) -> dict[str, Any]:
    ensure_project(project_id)
    update_project_index(project_id, max(payload.index, 0))
    return {"ok": True}


@app.post("/api/projects/{project_id}/rescan")
def api_rescan(project_id: int) -> dict[str, Any]:
    project = ensure_project(project_id)
    storage_dir = project_dir(project)
    storage_dir.mkdir(parents=True, exist_ok=True)

    collected: list[tuple[str, str]] = []
    for file_path in storage_dir.rglob("*"):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        rel_path = file_path.relative_to(storage_dir).as_posix()
        collected.append((rel_path, file_path.name))

    if collected:
        add_images(project_id, collected)

    watcher.watch_project(project_id, storage_dir)

    return {"ok": True}
