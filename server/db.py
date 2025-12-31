from __future__ import annotations

import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterable

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = BASE_DIR / "uploads"
DB_PATH = DATA_DIR / "labeling.db"

DEFAULT_LABELS = ["Usable", "Too Blurry", "Wrong Setup", "Irrelevant"]


def utc_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


@contextmanager
def get_conn():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                storage_dir TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_index INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                rel_path TEXT NOT NULL,
                filename TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(project_id, rel_path),
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS labels (
                project_id INTEGER NOT NULL,
                rel_path TEXT NOT NULL,
                label TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(project_id, rel_path),
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS label_options (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(project_id, name),
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            """
        )


def create_project(name: str) -> dict:
    storage_dir = f"project_{uuid.uuid4().hex}"
    now = utc_now()
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO projects (name, storage_dir, created_at, updated_at, last_index)
            VALUES (?, ?, ?, ?, 0)
            """,
            (name, storage_dir, now, now),
        )
        project_id = cur.lastrowid
        for label in DEFAULT_LABELS:
            conn.execute(
                """
                INSERT OR IGNORE INTO label_options (project_id, name, created_at)
                VALUES (?, ?, ?)
                """,
                (project_id, label, now),
            )
    project = get_project(project_id)
    if not project:
        raise RuntimeError("Failed to create project")
    return project


def get_project(project_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT id, name, storage_dir, created_at, updated_at, last_index
            FROM projects
            WHERE id = ?
            """,
            (project_id,),
        ).fetchone()
        return dict(row) if row else None


def list_projects(include_storage_dir: bool = False) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                p.id,
                p.name,
                p.storage_dir,
                p.created_at,
                p.updated_at,
                p.last_index,
                (SELECT COUNT(*) FROM images WHERE project_id = p.id) AS image_count,
                (SELECT COUNT(*) FROM labels WHERE project_id = p.id) AS labeled_count
            FROM projects p
            ORDER BY p.updated_at DESC
            """
        ).fetchall()

    projects = []
    for row in rows:
        item = dict(row)
        if not include_storage_dir:
            item.pop("storage_dir", None)
        projects.append(item)
    return projects


def update_project_index(project_id: int, index: int) -> None:
    now = utc_now()
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE projects
            SET last_index = ?, updated_at = ?
            WHERE id = ?
            """,
            (index, now, project_id),
        )


def add_image(project_id: int, rel_path: str, filename: str) -> None:
    now = utc_now()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO images (project_id, rel_path, filename, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (project_id, rel_path, filename, now),
        )


def add_images(project_id: int, items: Iterable[tuple[str, str]]) -> None:
    now = utc_now()
    with get_conn() as conn:
        conn.executemany(
            """
            INSERT OR IGNORE INTO images (project_id, rel_path, filename, created_at)
            VALUES (?, ?, ?, ?)
            """,
            [(project_id, rel_path, filename, now) for rel_path, filename in items],
        )


def list_images(project_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                images.rel_path,
                images.filename,
                labels.label
            FROM images
            LEFT JOIN labels
                ON images.project_id = labels.project_id
                AND images.rel_path = labels.rel_path
            WHERE images.project_id = ?
            ORDER BY images.rel_path
            """,
            (project_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def set_label(project_id: int, rel_path: str, label: str | None) -> None:
    now = utc_now()
    with get_conn() as conn:
        if not label:
            conn.execute(
                """
                DELETE FROM labels
                WHERE project_id = ? AND rel_path = ?
                """,
                (project_id, rel_path),
            )
            return

        conn.execute(
            """
            INSERT INTO labels (project_id, rel_path, label, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(project_id, rel_path)
            DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at
            """,
            (project_id, rel_path, label, now),
        )


def list_label_options(project_id: int) -> list[str]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT name FROM label_options
            WHERE project_id = ?
            ORDER BY id
            """,
            (project_id,),
        ).fetchall()
    return [row["name"] for row in rows]


def add_label_option(project_id: int, name: str) -> list[str]:
    now = utc_now()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO label_options (project_id, name, created_at)
            VALUES (?, ?, ?)
            """,
            (project_id, name, now),
        )
    return list_label_options(project_id)
