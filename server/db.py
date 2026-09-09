from __future__ import annotations

import sqlite3
import shutil
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterable

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = BASE_DIR / "uploads"
DB_PATH = DATA_DIR / "labeling.db"
BACKUP_DIR = DATA_DIR / "backups"

DEFAULT_CATEGORY_NAME = "Quality"


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


def _ensure_local_schema(conn: sqlite3.Connection) -> None:
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


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS label_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(normalized_name)
        );

        CREATE TABLE IF NOT EXISTS label_options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(category_id, normalized_name),
            FOREIGN KEY(category_id) REFERENCES label_categories(id)
        );

        CREATE TABLE IF NOT EXISTS project_label_categories (
            project_id INTEGER NOT NULL,
            category_id INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            PRIMARY KEY(project_id, category_id),
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY(category_id) REFERENCES label_categories(id)
        );

        CREATE TABLE IF NOT EXISTS image_labels (
            project_id INTEGER NOT NULL,
            rel_path TEXT NOT NULL,
            category_id INTEGER NOT NULL,
            label_option_id INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(project_id, rel_path, category_id, label_option_id),
            FOREIGN KEY(project_id, rel_path) REFERENCES images(project_id, rel_path) ON DELETE CASCADE,
            FOREIGN KEY(category_id) REFERENCES label_categories(id),
            FOREIGN KEY(label_option_id) REFERENCES label_options(id)
        );
        """
    )


def _ensure_category_sort_order(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "label_categories"):
        return
    if not _table_has_column(conn, "label_categories", "project_id"):
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
    _ensure_local_schema(conn)
    conn.execute(
        """
        INSERT INTO image_labels
        (project_id, rel_path, category_id, label_option_id, updated_at)
        SELECT project_id, rel_path, category_id, label_option_id, updated_at
        FROM image_labels_legacy
        """
    )


def _migrate_legacy_schema(conn: sqlite3.Connection) -> None:
    has_shared_categories = _table_exists(conn, "label_categories") and not _table_has_column(
        conn, "label_categories", "project_id"
    )
    has_legacy_options = _table_exists(conn, "label_options") and not _table_has_column(
        conn, "label_options", "category_id"
    )
    has_legacy_labels = _table_exists(conn, "labels") and not has_shared_categories
    if not has_legacy_options and not has_legacy_labels:
        return

    if _table_exists(conn, "label_options") and not _table_has_column(
        conn, "label_options", "category_id"
    ):
        conn.execute("ALTER TABLE label_options RENAME TO label_options_legacy")

    _ensure_local_schema(conn)

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


def normalize_schema_name(name: str) -> str:
    return " ".join(name.strip().casefold().split())


def _backup_database(reason: str) -> Path | None:
    if not DB_PATH.exists():
        return None

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    backup_path = BACKUP_DIR / f"labeling-{stamp}-{reason}.db"
    shutil.copy2(DB_PATH, backup_path)
    return backup_path


def _needs_shared_schema_migration(conn: sqlite3.Connection) -> bool:
    if not _table_exists(conn, "label_categories"):
        return False
    return _table_has_column(conn, "label_categories", "project_id")


def _migrate_shared_schema(conn: sqlite3.Connection) -> None:
    if not _needs_shared_schema_migration(conn):
        return

    _backup_database("before-shared-labels")
    now = utc_now()
    old_categories = [
        dict(row)
        for row in conn.execute(
            """
            SELECT id, project_id, name, sort_order, created_at
            FROM label_categories
            ORDER BY created_at, id
            """
        ).fetchall()
    ]
    old_options = [
        dict(row)
        for row in conn.execute(
            """
            SELECT id, project_id, category_id, name, created_at
            FROM label_options
            ORDER BY created_at, id
            """
        ).fetchall()
    ]
    old_image_labels = [
        dict(row)
        for row in conn.execute(
            """
            SELECT project_id, rel_path, category_id, label_option_id, updated_at
            FROM image_labels
            """
        ).fetchall()
    ]

    if _table_exists(conn, "label_categories_project_local"):
        raise RuntimeError("Shared schema migration backup table already exists")

    conn.execute("ALTER TABLE label_categories RENAME TO label_categories_project_local")
    conn.execute("ALTER TABLE label_options RENAME TO label_options_project_local")
    conn.execute("ALTER TABLE image_labels RENAME TO image_labels_project_local")
    _ensure_schema(conn)

    categories_by_norm: dict[str, dict] = {}
    old_category_to_shared: dict[int, int] = {}
    for category in old_categories:
        normalized = normalize_schema_name(category["name"])
        if not normalized:
            normalized = f"__legacy_category_{category['id']}"
        display_name = category["name"].strip() or f"Legacy Category {category['id']}"
        existing = categories_by_norm.get(normalized)
        if not existing:
            existing = {
                "id": category["id"],
                "name": display_name,
                "normalized_name": normalized,
                "created_at": category["created_at"] or now,
            }
            categories_by_norm[normalized] = existing
        old_category_to_shared[category["id"]] = existing["id"]

    for category in categories_by_norm.values():
        conn.execute(
            """
            INSERT INTO label_categories (id, name, normalized_name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                category["id"],
                category["name"],
                category["normalized_name"],
                category["created_at"],
            ),
        )

    project_category_links: dict[tuple[int, int], dict] = {}
    for category in old_categories:
        shared_category_id = old_category_to_shared.get(category["id"])
        if shared_category_id is None:
            continue
        key = (category["project_id"], shared_category_id)
        existing = project_category_links.get(key)
        sort_order = category["sort_order"] if category["sort_order"] is not None else 0
        if existing and existing["sort_order"] <= sort_order:
            continue
        project_category_links[key] = {
            "project_id": category["project_id"],
            "category_id": shared_category_id,
            "sort_order": sort_order,
            "created_at": category["created_at"] or now,
        }

    for link in project_category_links.values():
        conn.execute(
            """
            INSERT INTO project_label_categories
            (project_id, category_id, sort_order, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                link["project_id"],
                link["category_id"],
                link["sort_order"],
                link["created_at"],
            ),
        )

    options_by_category_norm: dict[tuple[int, str], dict] = {}
    old_option_to_shared: dict[int, int] = {}
    for option in old_options:
        shared_category_id = old_category_to_shared.get(option["category_id"])
        if shared_category_id is None:
            continue
        normalized = normalize_schema_name(option["name"])
        if not normalized:
            normalized = f"__legacy_label_{option['id']}"
        display_name = option["name"].strip() or f"Legacy Label {option['id']}"
        key = (shared_category_id, normalized)
        existing = options_by_category_norm.get(key)
        if not existing:
            existing = {
                "id": option["id"],
                "category_id": shared_category_id,
                "name": display_name,
                "normalized_name": normalized,
                "created_at": option["created_at"] or now,
            }
            options_by_category_norm[key] = existing
        old_option_to_shared[option["id"]] = existing["id"]

    for option in options_by_category_norm.values():
        conn.execute(
            """
            INSERT INTO label_options
            (id, category_id, name, normalized_name, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                option["id"],
                option["category_id"],
                option["name"],
                option["normalized_name"],
                option["created_at"],
            ),
        )

    old_label_count = len(old_image_labels)
    for label in old_image_labels:
        shared_category_id = old_category_to_shared.get(label["category_id"])
        shared_option_id = old_option_to_shared.get(label["label_option_id"])
        if shared_category_id is None or shared_option_id is None:
            raise RuntimeError("Shared schema migration could not map an image label")
        conn.execute(
            """
            INSERT OR IGNORE INTO image_labels
            (project_id, rel_path, category_id, label_option_id, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                label["project_id"],
                label["rel_path"],
                shared_category_id,
                shared_option_id,
                label["updated_at"] or now,
            ),
        )

    new_label_count = conn.execute(
        "SELECT COUNT(*) AS count FROM image_labels"
    ).fetchone()["count"]
    duplicate_collapses = old_label_count - new_label_count
    if duplicate_collapses < 0:
        raise RuntimeError("Shared schema migration created extra image labels")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migration_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            detail TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        INSERT INTO schema_migration_events (name, created_at, detail)
        VALUES (?, ?, ?)
        """,
        (
            "shared-labels",
            now,
            f"old_image_labels={old_label_count}; new_image_labels={new_label_count}; duplicate_collapses={duplicate_collapses}",
        ),
    )

    problems = conn.execute("PRAGMA foreign_key_check").fetchall()
    if problems:
        raise RuntimeError("Shared schema migration failed foreign key validation")


def init_db() -> None:
    with get_conn() as conn:
        _ensure_base_schema(conn)
        _migrate_legacy_schema(conn)
        _migrate_image_labels_multi(conn)
        _ensure_category_sort_order(conn)
        _migrate_shared_schema(conn)
        _ensure_schema(conn)


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
                (
                    SELECT COUNT(DISTINCT image_labels.rel_path)
                    FROM image_labels
                    JOIN project_label_categories plc
                        ON image_labels.project_id = plc.project_id
                        AND image_labels.category_id = plc.category_id
                    WHERE image_labels.project_id = p.id
                ) AS labeled_count
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


def update_project_name(project_id: int, name: str) -> None:
    now = utc_now()
    with get_conn() as conn:
        cur = conn.execute(
            """
            UPDATE projects
            SET name = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, now, project_id),
        )
        if cur.rowcount == 0:
            raise ValueError("Project not found")


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
                plc.category_id AS visible_category_id,
                label_options.name AS label_name
            FROM images
            LEFT JOIN image_labels
                ON images.project_id = image_labels.project_id
                AND images.rel_path = image_labels.rel_path
            LEFT JOIN project_label_categories plc
                ON image_labels.project_id = plc.project_id
                AND image_labels.category_id = plc.category_id
            LEFT JOIN label_options
                ON image_labels.label_option_id = label_options.id
                AND image_labels.category_id = label_options.category_id
            WHERE images.project_id = ?
            ORDER BY images.rel_path, plc.sort_order, image_labels.category_id, image_labels.label_option_id
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

        if (
            row["category_id"] is not None
            and row["label_option_id"] is not None
            and row["visible_category_id"] is not None
            and row["label_name"] is not None
        ):
            item["labels"].append(
                {
                    "category_id": row["category_id"],
                    "label_option_id": row["label_option_id"],
                    "label_name": row["label_name"] or "",
                }
            )

    return list(grouped.values())


def escape_like(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )


def search_images(filename: str, limit: int = 50) -> list[dict]:
    query = filename.strip()
    if not query:
        return []

    pattern = f"%{escape_like(query)}%"
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                p.id AS project_id,
                p.name AS project_name,
                images.rel_path,
                images.filename
            FROM images
            JOIN projects p
                ON images.project_id = p.id
            WHERE images.filename LIKE ? ESCAPE '\\'
                OR images.rel_path LIKE ? ESCAPE '\\'
            ORDER BY
                lower(images.filename) = lower(?) DESC,
                lower(images.rel_path) = lower(?) DESC,
                p.created_at DESC,
                images.rel_path
            LIMIT ?
            """,
            (pattern, pattern, query, query, limit),
        ).fetchall()

    return [dict(row) for row in rows]


def list_label_schema(project_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                c.id AS category_id,
                c.name AS category_name,
                l.id AS label_id,
                l.name AS label_name
            FROM project_label_categories plc
            JOIN label_categories c
                ON plc.category_id = c.id
            LEFT JOIN label_options l
                ON c.id = l.category_id
            WHERE plc.project_id = ?
            ORDER BY plc.sort_order, c.id, l.id
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

    return categories


def list_label_counts(project_id: int) -> dict[str, list[dict]]:
    with get_conn() as conn:
        label_rows = conn.execute(
            """
            SELECT
                c.id AS category_id,
                c.name AS category_name,
                l.id AS label_id,
                l.name AS label_name,
                COUNT(DISTINCT image_labels.rel_path) AS count
            FROM image_labels
            JOIN project_label_categories plc
                ON image_labels.project_id = plc.project_id
                AND image_labels.category_id = plc.category_id
            JOIN label_categories c
                ON image_labels.category_id = c.id
            JOIN label_options l
                ON image_labels.label_option_id = l.id
                AND image_labels.category_id = l.category_id
            WHERE image_labels.project_id = ?
            GROUP BY c.id, l.id
            ORDER BY plc.sort_order, c.id, l.id
            """,
            (project_id,),
        ).fetchall()

        category_rows = conn.execute(
            """
            SELECT
                c.id AS category_id,
                c.name AS category_name,
                COUNT(DISTINCT image_labels.rel_path) AS count
            FROM image_labels
            JOIN project_label_categories plc
                ON image_labels.project_id = plc.project_id
                AND image_labels.category_id = plc.category_id
            JOIN label_categories c
                ON image_labels.category_id = c.id
            WHERE image_labels.project_id = ?
            GROUP BY c.id
            ORDER BY plc.sort_order, c.id
            """,
            (project_id,),
        ).fetchall()

    return {
        "labels": [dict(row) for row in label_rows],
        "categories": [dict(row) for row in category_rows],
    }


def add_category(project_id: int, name: str) -> list[dict]:
    now = utc_now()
    display_name = name.strip()
    normalized = normalize_schema_name(display_name)
    if not normalized:
        raise ValueError("Category name required")
    with get_conn() as conn:
        category = conn.execute(
            """
            SELECT id FROM label_categories
            WHERE normalized_name = ?
            """,
            (normalized,),
        ).fetchone()
        if category:
            category_id = category["id"]
        else:
            cur = conn.execute(
                """
                INSERT INTO label_categories (name, normalized_name, created_at)
                VALUES (?, ?, ?)
                """,
                (display_name, normalized, now),
            )
            category_id = cur.lastrowid

        next_order = conn.execute(
            """
            SELECT COALESCE(MAX(sort_order), -1) AS max_order
            FROM project_label_categories
            WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()["max_order"]
        sort_order = int(next_order) + 1
        conn.execute(
            """
            INSERT OR IGNORE INTO project_label_categories
            (project_id, category_id, sort_order, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (project_id, category_id, sort_order, now),
        )
    return list_label_schema(project_id)


def update_category(project_id: int, category_id: int, name: str) -> list[dict]:
    display_name = name.strip()
    normalized = normalize_schema_name(display_name)
    if not normalized:
        raise ValueError("Category name required")
    with get_conn() as conn:
        link = conn.execute(
            """
            SELECT 1 FROM project_label_categories
            WHERE project_id = ? AND category_id = ?
            """,
            (project_id, category_id),
        ).fetchone()
        if not link:
            raise ValueError("Category not found")
        cur = conn.execute(
            """
            UPDATE label_categories
            SET name = ?, normalized_name = ?
            WHERE id = ?
            """,
            (display_name, normalized, category_id),
        )
        if cur.rowcount == 0:
            raise ValueError("Category not found")
    return list_label_schema(project_id)


def update_category_order(project_id: int, order: list[int]) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT category_id, sort_order
            FROM project_label_categories
            WHERE project_id = ?
            ORDER BY sort_order, category_id
            """,
            (project_id,),
        ).fetchall()

        existing_ids = [row["category_id"] for row in rows]
        existing_set = set(existing_ids)

        ordered_ids = [category_id for category_id in order if category_id in existing_set]
        remaining_ids = [category_id for category_id in existing_ids if category_id not in ordered_ids]
        final_order = ordered_ids + remaining_ids

        for index, category_id in enumerate(final_order):
            conn.execute(
                """
                UPDATE project_label_categories
                SET sort_order = ?
                WHERE category_id = ? AND project_id = ?
                """,
                (index, category_id, project_id),
            )

    return list_label_schema(project_id)


def delete_category(project_id: int, category_id: int, scope: str = "project") -> list[dict]:
    with get_conn() as conn:
        if scope == "all":
            cur = conn.execute(
                """
                DELETE FROM project_label_categories
                WHERE category_id = ?
                """,
                (category_id,),
            )
        elif scope == "project":
            cur = conn.execute(
                """
                DELETE FROM project_label_categories
                WHERE category_id = ? AND project_id = ?
                """,
                (category_id, project_id),
            )
        else:
            raise ValueError("Invalid category delete scope")
        if cur.rowcount == 0:
            raise ValueError("Category not found")
    return list_label_schema(project_id)


def add_label_option(project_id: int, category_id: int, name: str) -> list[dict]:
    now = utc_now()
    display_name = name.strip()
    normalized = normalize_schema_name(display_name)
    if not normalized:
        raise ValueError("Label name required")
    with get_conn() as conn:
        category = conn.execute(
            """
            SELECT category_id FROM project_label_categories
            WHERE category_id = ? AND project_id = ?
            """,
            (category_id, project_id),
        ).fetchone()
        if not category:
            raise ValueError("Category not found")
        conn.execute(
            """
            INSERT OR IGNORE INTO label_options
            (category_id, name, normalized_name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (category_id, display_name, normalized, now),
        )
    return list_label_schema(project_id)


def update_label_option(project_id: int, label_id: int, name: str) -> list[dict]:
    display_name = name.strip()
    normalized = normalize_schema_name(display_name)
    if not normalized:
        raise ValueError("Label name required")
    with get_conn() as conn:
        link = conn.execute(
            """
            SELECT 1
            FROM label_options l
            JOIN project_label_categories plc
                ON l.category_id = plc.category_id
            WHERE l.id = ? AND plc.project_id = ?
            """,
            (label_id, project_id),
        ).fetchone()
        if not link:
            raise ValueError("Label not found")
        cur = conn.execute(
            """
            UPDATE label_options
            SET name = ?, normalized_name = ?
            WHERE id = ?
            """,
            (display_name, normalized, label_id),
        )
        if cur.rowcount == 0:
            raise ValueError("Label not found")
    return list_label_schema(project_id)


def delete_label_option(project_id: int, label_id: int) -> list[dict]:
    raise ValueError(
        "Labels are shared category definitions and cannot be deleted. Add labels instead."
    )


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
            SELECT category_id FROM project_label_categories
            WHERE category_id = ? AND project_id = ?
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
            WHERE id = ? AND category_id = ?
            """,
            (label_option_id, category_id),
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
