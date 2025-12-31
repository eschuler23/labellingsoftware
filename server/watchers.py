from __future__ import annotations

from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .db import add_image

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}


class ProjectEventHandler(FileSystemEventHandler):
    def __init__(self, project_id: int, root_dir: Path) -> None:
        super().__init__()
        self.project_id = project_id
        self.root_dir = root_dir

    def on_created(self, event) -> None:
        if event.is_directory:
            return
        self._handle_path(Path(event.src_path))

    def on_moved(self, event) -> None:
        if event.is_directory:
            return
        self._handle_path(Path(event.dest_path))

    def _handle_path(self, path: Path) -> None:
        if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            return
        try:
            rel_path = path.relative_to(self.root_dir).as_posix()
        except ValueError:
            return
        add_image(self.project_id, rel_path, path.name)


class UploadWatcher:
    def __init__(self) -> None:
        self._observer = Observer()
        self._watched: set[int] = set()
        self._running = False

    def watch_project(self, project_id: int, root_dir: Path) -> None:
        if project_id in self._watched:
            return
        root_dir.mkdir(parents=True, exist_ok=True)
        handler = ProjectEventHandler(project_id, root_dir)
        self._observer.schedule(handler, str(root_dir), recursive=True)
        self._watched.add(project_id)

    def start(self) -> None:
        if not self._running:
            self._observer.start()
            self._running = True

    def stop(self) -> None:
        if self._running:
            self._observer.stop()
            self._observer.join()
            self._running = False
