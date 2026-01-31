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

DEFAULT_CATEGORY_NAME = "Quality"
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


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def _table_has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table});").fetchall()
    return any(row["name"] == column for row in rows)


def _ensure_base_schema(conn: sqlite3.Connection) -> None:
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
        """
    )


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS label_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            UNIQUE(project_id, name),
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS label_options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            category_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(project_id, category_id, name),
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY(category_id) REFERENCES label_categories(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS image_labels (
            project_id INTEGER NOT NULL,
            rel_path TEXT NOT NULL,
            category_id INTEGER NOT NULL,
            label_option_id INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(project_id, rel_path, category_id, label_option_id),
            FOREIGN KEY(project_id, rel_path) REFERENCES images(project_id, rel_path) ON DELETE CASCADE,
            FOREIGN KEY(category_id) REFERENCES label_categories(id) ON DELETE CASCADE,
            FOREIGN KEY(label_option_id) REFERENCES label_options(id) ON DELETE CASCADE
        );
        """
    )


def _ensure_category_sort_order(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "label_categories"):
        return
    if _table_has_column(conn, "label_categories", "sort_order"):
        return

    conn.execute(
        "ALTER TABLE label_categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"
    )

    rows = conn.execute(
        """
        SELECT id, project_id
        FROM label_categories
        ORDER BY project_id, id
        """
    ).fetchall()

    current_project = None
    order = 0
    for row in rows:
        project_id = row["project_id"]
        if project_id != current_project:
            current_project = project_id
            order = 0
        conn.execute(
            "UPDATE label_categories SET sort_order = ? WHERE id = ?",
            (order, row["id"]),
        )
        order += 1


def _image_labels_empty(conn: sqlite3.Connection) -> bool:
    if not _table_exists(conn, "image_labels"):
        return True
    row = conn.execute("SELECT COUNT(*) AS count FROM image_labels").fetchone()
    return row["count"] == 0


def _image_labels_supports_multi(conn: sqlite3.Connection) -> bool:
    if not _table_exists(conn, "image_labels"):
        return True
    rows = conn.execute("PRAGMA table_info(image_labels);").fetchall()
    for row in rows:
        if row["name"] == "label_option_id":
            return row["pk"] > 0
    return False


def _migrate_image_labels_multi(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "image_labels"):
        return
    if _image_labels_supports_multi(conn):
        return

    conn.execute("ALTER TABLE image_labels RENAME TO image_labels_legacy")
    _ensure_schema(conn)
    conn.execute(
        """
        INSERT INTO image_labels
        (project_id, rel_path, category_id, label_option_id, updated_at)
        SELECT project_id, rel_path, category_id, label_option_id, updated_at
        FROM image_labels_legacy
        """
    )
    conn.execute("DROP TABLE IF EXISTS image_labels_legacy")


def _migrate_legacy_schema(conn: sqlite3.Connection) -> None:
    if _table_exists(conn, "label_options") and not _table_has_column(
        conn, "label_options", "category_id"
    ):
        conn.execute("ALTER TABLE label_options RENAME TO label_options_legacy")

    _ensure_schema(conn)

    if _table_exists(conn, "label_options_legacy"):
        projects = conn.execute("SELECT id FROM projects").fetchall()
        now = utc_now()
        for row in projects:
            project_id = row["id"]
            conn.execute(
                """
                INSERT OR IGNORE INTO label_categories (project_id, name, created_at)
                VALUES (?, ?, ?)
                """,
                (project_id, DEFAULT_CATEGORY_NAME, now),
            )
            category_id = conn.execute(
                """
                SELECT id FROM label_categories
                WHERE project_id = ? AND name = ?
                """,
                (project_id, DEFAULT_CATEGORY_NAME),
            ).fetchone()["id"]

            legacy_labels = conn.execute(
                """
                SELECT name, created_at FROM label_options_legacy
                WHERE project_id = ?
                """,
                (project_id,),
            ).fetchall()

            for legacy in legacy_labels:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO label_options (project_id, category_id, name, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (project_id, category_id, legacy["name"], legacy["created_at"] or now),
                )

        conn.execute("DROP TABLE IF EXISTS label_options_legacy")

    if _table_exists(conn, "labels") and _image_labels_empty(conn):
        now = utc_now()
        labels = conn.execute(
            """
            SELECT project_id, rel_path, label, updated_at
            FROM labels
            """
        ).fetchall()

        for row in labels:
            project_id = row["project_id"]
            label_name = row["label"]
            category = conn.execute(
                """
                SELECT id FROM label_categories
                WHERE project_id = ?
                ORDER BY id
                LIMIT 1
                """,
                (project_id,),
            ).fetchone()
            if not category:
                continue
            category_id = category["id"]
            label_option = conn.execute(
                """
                SELECT id FROM label_options
                WHERE project_id = ? AND category_id = ? AND name = ?
                """,
                (project_id, category_id, label_name),
            ).fetchone()
            if not label_option:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO label_options (project_id, category_id, name, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (project_id, category_id, label_name, now),
                )
                label_option = conn.execute(
                    """
                    SELECT id FROM label_options
                    WHERE project_id = ? AND category_id = ? AND name = ?
                    """,
                    (project_id, category_id, label_name),
                ).fetchone()

            conn.execute(
                """
                INSERT OR REPLACE INTO image_labels
                (project_id, rel_path, category_id, label_option_id, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    row["rel_path"],
                    category_id,
                    label_option["id"],
                    row["updated_at"] or now,
                ),
            )


def init_db() -> None:
    with get_conn() as conn:
        _ensure_base_schema(conn)
        _migrate_legacy_schema(conn)
        _migrate_image_labels_multi(conn)
        _ensure_schema(conn)
        _ensure_category_sort_order(conn)


def _ensure_default_category(conn: sqlite3.Connection, project_id: int) -> int:
    now = utc_now()
    next_order = conn.execute(
        """
        SELECT COALESCE(MAX(sort_order), -1) AS max_order
        FROM label_categories
        WHERE project_id = ?
        """,
        (project_id,),
    ).fetchone()["max_order"]
    sort_order = int(next_order) + 1
    conn.execute(
        """
        INSERT OR IGNORE INTO label_categories (project_id, name, sort_order, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (project_id, DEFAULT_CATEGORY_NAME, sort_order, now),
    )
    category = conn.execute(
        """
        SELECT id FROM label_categories
        WHERE project_id = ? AND name = ?
        """,
        (project_id, DEFAULT_CATEGORY_NAME),
    ).fetchone()
    return category["id"]


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

        category_id = _ensure_default_category(conn, project_id)
        for label in DEFAULT_LABELS:
            conn.execute(
                """
                INSERT OR IGNORE INTO label_options (project_id, category_id, name, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (project_id, category_id, label, now),
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


def delete_project(project_id: int) -> str:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT storage_dir FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if not row:
            raise ValueError("Project not found")
        storage_dir = row["storage_dir"]
        
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        
    return storage_dir


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
                (SELECT COUNT(DISTINCT rel_path) FROM image_labels WHERE project_id = p.id) AS labeled_count
            FROM projects p
            ORDER BY p.created_at DESC
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


def image_exists(project_id: int, rel_path: str) -> bool:
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT 1
            FROM images
            WHERE project_id = ? AND rel_path = ?
            """,
            (project_id, rel_path),
        ).fetchone()
        return row is not None


def delete_image(project_id: int, rel_path: str) -> None:
    with get_conn() as conn:
        cur = conn.execute(
            """
            DELETE FROM images
            WHERE project_id = ? AND rel_path = ?
            """,
            (project_id, rel_path),
        )
        if cur.rowcount == 0:
            raise ValueError("Image not found")


def list_images(project_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                images.rel_path,
                images.filename,
                image_labels.category_id,
                image_labels.label_option_id,
                label_options.name AS label_name
            FROM images
            LEFT JOIN image_labels
                ON images.project_id = image_labels.project_id
                AND images.rel_path = image_labels.rel_path
            LEFT JOIN label_options
                ON image_labels.label_option_id = label_options.id
            WHERE images.project_id = ?
            ORDER BY images.rel_path, image_labels.category_id, image_labels.label_option_id
            """,
            (project_id,),
        ).fetchall()

    grouped: dict[str, dict] = {}
    for row in rows:
        rel_path = row["rel_path"]
        item = grouped.get(rel_path)
        if not item:
            item = {
                "rel_path": rel_path,
                "filename": row["filename"],
                "labels": [],
            }
            grouped[rel_path] = item

        if row["category_id"] is not None and row["label_option_id"] is not None:
            item["labels"].append(
                {
                    "category_id": row["category_id"],
                    "label_option_id": row["label_option_id"],
                    "label_name": row["label_name"] or "",
                }
            )

    return list(grouped.values())


def list_label_schema(project_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                c.id AS category_id,
                c.name AS category_name,
                l.id AS label_id,
                l.name AS label_name
            FROM label_categories c
            LEFT JOIN label_options l
                ON c.id = l.category_id
            WHERE c.project_id = ?
            ORDER BY c.sort_order, c.id, l.id
            """,
            (project_id,),
        ).fetchall()

    categories: list[dict] = []
    current: dict | None = None
    for row in rows:
        if current is None or current["id"] != row["category_id"]:
            current = {
                "id": row["category_id"],
                "name": row["category_name"],
                "labels": [],
            }
            categories.append(current)
        if row["label_id"] is not None:
            current["labels"].append(
                {
                    "id": row["label_id"],
                    "name": row["label_name"],
                    "category_id": row["category_id"],
                }
            )

    if not categories:
        # ensure defaults for legacy projects
        with get_conn() as conn:
            category_id = _ensure_default_category(conn, project_id)
            now = utc_now()
            for label in DEFAULT_LABELS:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO label_options (project_id, category_id, name, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (project_id, category_id, label, now),
                )
        return list_label_schema(project_id)

    return categories


def add_category(project_id: int, name: str) -> list[dict]:
    now = utc_now()
    with get_conn() as conn:
        next_order = conn.execute(
            """
            SELECT COALESCE(MAX(sort_order), -1) AS max_order
            FROM label_categories
            WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()["max_order"]
        sort_order = int(next_order) + 1
        conn.execute(
            """
            INSERT OR IGNORE INTO label_categories (project_id, name, sort_order, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (project_id, name, sort_order, now),
        )
    return list_label_schema(project_id)


def update_category(project_id: int, category_id: int, name: str) -> list[dict]:
    with get_conn() as conn:
        cur = conn.execute(
            """
            UPDATE label_categories
            SET name = ?
            WHERE id = ? AND project_id = ?
            """,
            (name, category_id, project_id),
        )
        if cur.rowcount == 0:
            raise ValueError("Category not found")
    return list_label_schema(project_id)


def update_category_order(project_id: int, order: list[int]) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, sort_order
            FROM label_categories
            WHERE project_id = ?
            ORDER BY sort_order, id
            """,
            (project_id,),
        ).fetchall()

        existing_ids = [row["id"] for row in rows]
        existing_set = set(existing_ids)

        ordered_ids = [category_id for category_id in order if category_id in existing_set]
        remaining_ids = [category_id for category_id in existing_ids if category_id not in ordered_ids]
        final_order = ordered_ids + remaining_ids

        for index, category_id in enumerate(final_order):
            conn.execute(
                """
                UPDATE label_categories
                SET sort_order = ?
                WHERE id = ? AND project_id = ?
                """,
                (index, category_id, project_id),
            )

    return list_label_schema(project_id)


def delete_category(project_id: int, category_id: int) -> list[dict]:
    with get_conn() as conn:
        cur = conn.execute(
            """
            DELETE FROM label_categories
            WHERE id = ? AND project_id = ?
            """,
            (category_id, project_id),
        )
        if cur.rowcount == 0:
            raise ValueError("Category not found")
    return list_label_schema(project_id)


def add_label_option(project_id: int, category_id: int, name: str) -> list[dict]:
    now = utc_now()
    with get_conn() as conn:
        category = conn.execute(
            """
            SELECT id FROM label_categories
            WHERE id = ? AND project_id = ?
            """,
            (category_id, project_id),
        ).fetchone()
        if not category:
            raise ValueError("Category not found")
        conn.execute(
            """
            INSERT OR IGNORE INTO label_options (project_id, category_id, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (project_id, category_id, name, now),
        )
    return list_label_schema(project_id)


def update_label_option(project_id: int, label_id: int, name: str) -> list[dict]:
    with get_conn() as conn:
        cur = conn.execute(
            """
            UPDATE label_options
            SET name = ?
            WHERE id = ? AND project_id = ?
            """,
            (name, label_id, project_id),
        )
        if cur.rowcount == 0:
            raise ValueError("Label not found")
    return list_label_schema(project_id)


def delete_label_option(project_id: int, label_id: int) -> list[dict]:
    with get_conn() as conn:
        cur = conn.execute(
            """
            DELETE FROM label_options
            WHERE id = ? AND project_id = ?
            """,
            (label_id, project_id),
        )
        if cur.rowcount == 0:
            raise ValueError("Label not found")
    return list_label_schema(project_id)


def set_image_label(
    project_id: int,
    rel_path: str,
    category_id: int,
    label_option_id: int | None,
    mode: str = "replace",
) -> None:
    now = utc_now()
    with get_conn() as conn:
        category = conn.execute(
            """
            SELECT id FROM label_categories
            WHERE id = ? AND project_id = ?
            """,
            (category_id, project_id),
        ).fetchone()
        if not category:
            raise ValueError("Category not found")

        if label_option_id is None:
            conn.execute(
                """
                DELETE FROM image_labels
                WHERE project_id = ? AND rel_path = ? AND category_id = ?
                """,
                (project_id, rel_path, category_id),
            )
            return

        option = conn.execute(
            """
            SELECT id FROM label_options
            WHERE id = ? AND project_id = ? AND category_id = ?
            """,
            (label_option_id, project_id, category_id),
        ).fetchone()
        if not option:
            raise ValueError("Label option not found")

        if mode not in ("replace", "toggle"):
            raise ValueError("Invalid label mode")

        if mode == "toggle":
            existing = conn.execute(
                """
                SELECT 1 FROM image_labels
                WHERE project_id = ? AND rel_path = ? AND category_id = ? AND label_option_id = ?
                """,
                (project_id, rel_path, category_id, label_option_id),
            ).fetchone()
            if existing:
                conn.execute(
                    """
                    DELETE FROM image_labels
                    WHERE project_id = ? AND rel_path = ? AND category_id = ? AND label_option_id = ?
                    """,
                    (project_id, rel_path, category_id, label_option_id),
                )
                return
        else:
            conn.execute(
                """
                DELETE FROM image_labels
                WHERE project_id = ? AND rel_path = ? AND category_id = ?
                """,
                (project_id, rel_path, category_id),
            )

        conn.execute(
            """
            INSERT INTO image_labels
            (project_id, rel_path, category_id, label_option_id, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_id, rel_path, category_id, label_option_id)
            DO UPDATE SET updated_at = excluded.updated_at
            """,
            (project_id, rel_path, category_id, label_option_id, now),
        )
