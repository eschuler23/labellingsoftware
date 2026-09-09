from __future__ import annotations

import csv
import io
import shutil
import urllib.parse
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
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
    list_label_counts,
    list_label_schema,
    list_projects,
    search_images,
    set_image_label,
    update_category_order,
    update_category,
    update_label_option,
    update_project_index,
    update_project_name,
)
from .utils import THUMBNAIL_DIR_NAME, generate_thumbnail, get_thumbnail_path
from .watchers import SUPPORTED_EXTENSIONS, UploadWatcher

app = FastAPI(title="Labeling Backend")

BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIST_DIR = BASE_DIR / "web" / "dist"
WEB_DIST_INDEX = WEB_DIST_DIR / "index.html"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

watcher = UploadWatcher()

if (WEB_DIST_DIR / "assets").is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=str(WEB_DIST_DIR / "assets")),
        name="web-assets",
    )


class LabelUpdate(BaseModel):
    rel_path: str
    category_id: int
    label_option_id: int | None = None
    mode: str | None = None


class PositionUpdate(BaseModel):
    index: int


class ProjectRename(BaseModel):
    name: str


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


def csv_cell_has_label(value: str, label: str) -> bool:
    labels = [part.strip() for part in value.split(";")]
    return label in labels


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


@app.get("/api/images/search")
def api_search_images(filename: str, limit: int = 50) -> dict[str, Any]:
    query = filename.strip()
    if not query:
        return {"results": []}
    safe_limit = min(max(limit, 1), 100)
    return {"results": search_images(query, safe_limit)}


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


@app.post("/api/projects/{project_id}/csv-folder")
async def api_create_project_from_csv(
    project_id: int,
    csv_file: UploadFile = File(...),
    filename_column: str = Form(...),
    label_column: str = Form(...),
    label_value: str = Form(...),
    project_name: str | None = Form(default=None),
) -> dict[str, Any]:
    source_project = ensure_project(project_id)
    filename_column = filename_column.strip()
    label_column = label_column.strip()
    label_value = label_value.strip()
    if not filename_column or not label_column or not label_value:
        raise HTTPException(status_code=400, detail="CSV selection is incomplete")

    raw = await csv_file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV has no header row")
    if filename_column not in reader.fieldnames:
        raise HTTPException(status_code=400, detail="Filename column not found")
    if label_column not in reader.fieldnames:
        raise HTTPException(status_code=400, detail="Label column not found")

    selected_names: set[str] = set()
    csv_rows = 0
    matched_rows = 0
    for row in reader:
        csv_rows += 1
        filename = (row.get(filename_column) or "").strip()
        label_cell = (row.get(label_column) or "").strip()
        if filename and csv_cell_has_label(label_cell, label_value):
            matched_rows += 1
            selected_names.add(filename)
            selected_names.add(Path(filename).name)

    if not selected_names:
        raise HTTPException(
            status_code=400,
            detail="No CSV rows matched that label selection",
        )

    matched: list[tuple[dict, dict]] = []
    for project in list_projects(include_storage_dir=True):
        for item in list_images(project["id"]):
            if item["rel_path"] in selected_names or item["filename"] in selected_names:
                matched.append((project, item))
    if not matched:
        raise HTTPException(
            status_code=400,
            detail="No existing project images matched the selected CSV filenames",
        )

    default_name = f"{source_project['name']} - {label_value}"
    new_project = create_project((project_name or default_name).strip() or default_name)
    target_dir = project_dir(new_project)
    target_root = target_dir.resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    collected: list[tuple[str, str]] = []
    copied_paths: set[str] = set()
    for source_project_item, item in matched:
        rel_path = sanitize_rel_path(item["rel_path"])
        source_dir = project_dir(source_project_item)
        source_root = source_dir.resolve()
        source_path = (source_dir / rel_path).resolve()
        target_path = (target_dir / rel_path).resolve()
        if not source_path.is_relative_to(source_root) or not source_path.is_file():
            continue
        if not target_path.is_relative_to(target_root):
            continue
        if rel_path in copied_paths:
            continue
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target_path)
        generate_thumbnail(target_path)
        collected.append((rel_path, Path(rel_path).name))
        copied_paths.add(rel_path)

    if not collected:
        delete_project(new_project["id"])
        if target_dir.exists():
            shutil.rmtree(target_dir)
        raise HTTPException(status_code=400, detail="No image files could be copied")

    add_images(new_project["id"], collected)
    watcher.watch_project(new_project["id"], target_dir)

    refreshed_project = get_project(new_project["id"]) or new_project
    return {
        "project": refreshed_project,
        "matched_rows": matched_rows,
        "copied": len(collected),
        "csv_rows": csv_rows,
    }


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


@app.patch("/api/projects/{project_id}")
def api_rename_project(project_id: int, payload: ProjectRename) -> dict[str, Any]:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Project name required")
    try:
        update_project_name(project_id, name)
    except ValueError:
        raise HTTPException(status_code=404, detail="Project not found")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@app.get("/api/projects/{project_id}/images")
def api_list_images(project_id: int) -> dict[str, Any]:
    project = ensure_project(project_id)
    images = list_images(project_id)
    storage_dir = project_dir(project)
    root_path = storage_dir.resolve()
    output = []
    missing: list[str] = []
    for item in images:
        rel_path = item["rel_path"]
        full_path = (storage_dir / rel_path).resolve()
        if not full_path.is_relative_to(root_path) or not full_path.is_file():
            missing.append(rel_path)
            continue
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

    if missing:
        for rel_path in missing:
            try:
                delete_image(project_id, rel_path)
            except ValueError:
                pass
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


@app.get("/api/projects/{project_id}/label-counts")
def api_label_counts(project_id: int) -> dict[str, Any]:
    ensure_project(project_id)
    return list_label_counts(project_id)


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
    mode = (payload.mode or "replace").lower()
    if mode not in ("replace", "toggle"):
        raise HTTPException(status_code=400, detail="Invalid label mode")
    try:
        set_image_label(
            project_id,
            rel_path,
            payload.category_id,
            payload.label_option_id,
            mode,
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


@app.get("/", include_in_schema=False)
def serve_frontend_root() -> FileResponse:
    if not WEB_DIST_INDEX.is_file():
        raise HTTPException(status_code=404, detail="Frontend is not built")
    return FileResponse(WEB_DIST_INDEX)


@app.get("/{full_path:path}", include_in_schema=False)
def serve_frontend(full_path: str) -> FileResponse:
    if full_path.startswith("api"):
        raise HTTPException(status_code=404, detail="Not found")
    if not WEB_DIST_INDEX.is_file():
        raise HTTPException(status_code=404, detail="Frontend is not built")

    requested = (WEB_DIST_DIR / full_path).resolve()
    if requested.is_file() and requested.is_relative_to(WEB_DIST_DIR.resolve()):
        return FileResponse(requested)

    return FileResponse(WEB_DIST_INDEX)
