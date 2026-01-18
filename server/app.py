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
    add_category,
    add_images,
    add_label_option,
    create_project,
    delete_category,
    delete_image,
    delete_label_option,
    delete_project,
    get_project,
    image_exists,
    init_db,
    list_images,
    list_label_schema,
    list_projects,
    set_image_label,
    update_category_order,
    update_category,
    update_label_option,
    update_project_index,
)
from .utils import THUMBNAIL_DIR_NAME, generate_thumbnail, get_thumbnail_path
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
    category_id: int
    label_option_id: int | None = None


class PositionUpdate(BaseModel):
    index: int


class CategoryCreate(BaseModel):
    name: str


class CategoryRename(BaseModel):
    category_id: int
    name: str


class CategoryDelete(BaseModel):
    category_id: int


class CategoryOrderUpdate(BaseModel):
    order: list[int]


class LabelCreate(BaseModel):
    category_id: int
    name: str


class LabelRename(BaseModel):
    label_id: int
    name: str


class LabelDelete(BaseModel):
    label_id: int


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
def api_upload_project(
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

        if THUMBNAIL_DIR_NAME in Path(rel_path).parts:
            continue

        if Path(rel_path).suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue

        dest = storage_dir / rel_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as f:
            shutil.copyfileobj(upload.file, f)
        
        # Generate thumbnail
        generate_thumbnail(dest)

        collected.append((rel_path, Path(rel_path).name))

    if collected:
        add_images(project["id"], collected)

    watcher.watch_project(project["id"], storage_dir)

    return {"project": project}


@app.delete("/api/projects/{project_id}")
def api_delete_project(project_id: int) -> dict[str, Any]:
    try:
        storage_dir_name = delete_project(project_id)
        storage_dir = UPLOADS_DIR / storage_dir_name
        if storage_dir.exists():
            shutil.rmtree(storage_dir)
        watcher.unwatch_project(project_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Project not found")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"ok": True}


@app.get("/api/projects/{project_id}/images")
def api_list_images(project_id: int) -> dict[str, Any]:
    project = ensure_project(project_id)
    images = list_images(project_id)
    output = []
    for item in images:
        rel_path = item["rel_path"]
        url = f"/api/projects/{project_id}/image?path={urllib.parse.quote(rel_path, safe='')}"
        thumbnail_url = f"{url}&thumbnail=true"
        output.append(
            {
                "rel_path": rel_path,
                "filename": item["filename"],
                "labels": item["labels"],
                "url": url,
                "thumbnail_url": thumbnail_url,
            }
        )
    return {"images": output, "last_index": project["last_index"]}


@app.get("/api/projects/{project_id}/image")
def api_get_image(project_id: int, path: str, thumbnail: bool = False) -> FileResponse:
    project = ensure_project(project_id)
    rel_path = sanitize_rel_path(path)
    storage_dir = project_dir(project)
    full_path = (storage_dir / rel_path).resolve()
    root_path = storage_dir.resolve()
    if not full_path.is_file() or not full_path.is_relative_to(root_path):
        raise HTTPException(status_code=404, detail="Image not found")
    
    if thumbnail:
        thumb_path = get_thumbnail_path(full_path)
        if thumb_path.exists():
            return FileResponse(thumb_path)
        # If thumbnail doesn't exist, try to generate it on the fly
        try:
            thumb_path = generate_thumbnail(full_path)
            if thumb_path.exists():
                return FileResponse(thumb_path)
        except Exception:
            pass # Fallback to original
            
    return FileResponse(full_path)


@app.delete("/api/projects/{project_id}/image")
def api_delete_image(project_id: int, path: str) -> dict[str, Any]:
    project = ensure_project(project_id)
    rel_path = sanitize_rel_path(path)
    storage_dir = project_dir(project)
    full_path = (storage_dir / rel_path).resolve()
    root_path = storage_dir.resolve()
    if not full_path.is_relative_to(root_path):
        raise HTTPException(status_code=400, detail="Invalid path")

    file_exists = full_path.is_file()
    db_exists = image_exists(project_id, rel_path)
    if not file_exists and not db_exists:
        raise HTTPException(status_code=404, detail="Image not found")

    try:
        if file_exists:
            full_path.unlink()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    thumb_path = get_thumbnail_path(full_path)
    try:
        if thumb_path.exists():
            thumb_path.unlink()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if db_exists:
        try:
            delete_image(project_id, rel_path)
        except ValueError:
            pass

    return {"ok": True}


@app.get("/api/projects/{project_id}/label-schema")
def api_label_schema(project_id: int) -> dict[str, Any]:
    ensure_project(project_id)
    return {"categories": list_label_schema(project_id)}


@app.post("/api/projects/{project_id}/label-categories")
def api_add_label_category(project_id: int, payload: CategoryCreate) -> dict[str, Any]:
    ensure_project(project_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Category name required")
    try:
        categories = add_category(project_id, name)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"categories": categories}


@app.patch("/api/projects/{project_id}/label-categories")
def api_update_label_category(project_id: int, payload: CategoryRename) -> dict[str, Any]:
    ensure_project(project_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Category name required")
    try:
        categories = update_category(project_id, payload.category_id, name)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"categories": categories}


@app.delete("/api/projects/{project_id}/label-categories")
def api_delete_label_category(project_id: int, payload: CategoryDelete) -> dict[str, Any]:
    ensure_project(project_id)
    try:
        categories = delete_category(project_id, payload.category_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"categories": categories}


@app.post("/api/projects/{project_id}/label-categories/order")
def api_update_label_category_order(
    project_id: int, payload: CategoryOrderUpdate
) -> dict[str, Any]:
    ensure_project(project_id)
    try:
        categories = update_category_order(project_id, payload.order)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"categories": categories}


@app.post("/api/projects/{project_id}/label-options")
def api_add_label_option(project_id: int, payload: LabelCreate) -> dict[str, Any]:
    ensure_project(project_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Label name required")
    try:
        categories = add_label_option(project_id, payload.category_id, name)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"categories": categories}


@app.patch("/api/projects/{project_id}/label-options")
def api_update_label_option(project_id: int, payload: LabelRename) -> dict[str, Any]:
    ensure_project(project_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Label name required")
    try:
        categories = update_label_option(project_id, payload.label_id, name)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"categories": categories}


@app.delete("/api/projects/{project_id}/label-options")
def api_delete_label_option(project_id: int, payload: LabelDelete) -> dict[str, Any]:
    ensure_project(project_id)
    try:
        categories = delete_label_option(project_id, payload.label_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"categories": categories}


@app.post("/api/projects/{project_id}/labels")
def api_set_label(project_id: int, payload: LabelUpdate) -> dict[str, Any]:
    ensure_project(project_id)
    rel_path = sanitize_rel_path(payload.rel_path)
    try:
        set_image_label(
            project_id,
            rel_path,
            payload.category_id,
            payload.label_option_id,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
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
        if THUMBNAIL_DIR_NAME in file_path.parts:
            continue
        if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        
        # Generate thumbnail
        generate_thumbnail(file_path)

        rel_path = file_path.relative_to(storage_dir).as_posix()
        collected.append((rel_path, file_path.name))

    if collected:
        add_images(project_id, collected)

    watcher.watch_project(project_id, storage_dir)

    return {"ok": True}
