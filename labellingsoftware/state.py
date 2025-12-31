"""Application state management for folder-based image labeling."""

import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import Optional

import reflex as rx

from .models import ImageLabel, Project

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}
LABEL_OPTIONS = ["Usable", "Too Blurry", "Wrong Setup", "Irrelevant"]


class AppState(rx.State):
    """Main application state for folder-based image labeling."""

    # Project management
    projects: list[dict] = []
    selected_project_id: Optional[int] = None
    selected_project_name: str = ""
    selected_project_path: str = ""

    # Image browsing within selected project
    image_files: list[str] = []
    current_image_index: int = 0

    # Labels for current project (cached for performance)
    image_labels: dict[str, str] = {}

    # UI state
    folder_input: str = ""
    show_add_folder_dialog: bool = False

    # Computed properties
    @rx.var
    def current_image_filename(self) -> str:
        if not self.image_files or self.current_image_index >= len(self.image_files):
            return ""
        return self.image_files[self.current_image_index]

    @rx.var
    def current_image_url(self) -> str:
        """Build URL for serving current image via custom API."""
        if not self.selected_project_path or not self.current_image_filename:
            return ""
        full_path = str(Path(self.selected_project_path) / self.current_image_filename)
        # Use backend URL directly since frontend doesn't proxy our custom route
        return f"http://localhost:8000/_image?path={urllib.parse.quote(full_path, safe='')}"

    @rx.var
    def current_image_label(self) -> str:
        """Get label for current image (if any)."""
        if not self.current_image_filename:
            return ""
        return self.image_labels.get(self.current_image_filename, "")

    @rx.var
    def total_images(self) -> int:
        return len(self.image_files)

    @rx.var
    def labeled_count(self) -> int:
        return len(self.image_labels)

    @rx.var
    def has_project_selected(self) -> bool:
        return self.selected_project_id is not None

    @rx.var
    def progress_percent(self) -> int:
        if not self.image_files:
            return 0
        return int((len(self.image_labels) / len(self.image_files)) * 100)

    @rx.var
    def progress_text(self) -> str:
        if not self.image_files:
            return "No images"
        return f"Image {self.current_image_index + 1} of {self.total_images}"

    @rx.var
    def labeled_text(self) -> str:
        return f"{self.labeled_count} labeled ({self.progress_percent}%)"

    # Lifecycle
    def on_load(self):
        """Called when page loads - fetch projects from database."""
        self.load_projects()

    def load_projects(self):
        """Load all projects from database."""
        with rx.session() as session:
            db_projects = session.exec(
                Project.select().order_by(Project.last_accessed.desc())
            ).all()
            self.projects = [
                {
                    "id": p.id,
                    "name": p.name,
                    "path": p.path,
                }
                for p in db_projects
            ]

    # Project management
    def set_folder_input(self, value: str):
        self.folder_input = value

    def toggle_add_folder_dialog(self):
        self.show_add_folder_dialog = not self.show_add_folder_dialog
        if not self.show_add_folder_dialog:
            self.folder_input = ""

    def add_project(self):
        """Add a new project from folder_input path."""
        path = self.folder_input.strip()
        if not path:
            return

        folder = Path(path)
        if not folder.exists() or not folder.is_dir():
            return

        resolved_path = str(folder.resolve())

        with rx.session() as session:
            # Check if project already exists
            existing = session.exec(
                Project.select().where(Project.path == resolved_path)
            ).first()

            if existing:
                self.folder_input = ""
                self.show_add_folder_dialog = False
                self.select_project(existing.id)
                return

            # Create new project
            project = Project(
                name=folder.name,
                path=resolved_path,
                created_at=datetime.now(),
                last_accessed=datetime.now(),
            )
            session.add(project)
            session.commit()
            session.refresh(project)
            new_id = project.id

        self.folder_input = ""
        self.show_add_folder_dialog = False
        self.load_projects()
        self.select_project(new_id)

    def remove_project(self, project_id: int):
        """Remove a project and its labels from database."""
        with rx.session() as session:
            # Delete labels first
            labels = session.exec(
                ImageLabel.select().where(ImageLabel.project_id == project_id)
            ).all()
            for label in labels:
                session.delete(label)

            # Delete project
            project = session.exec(
                Project.select().where(Project.id == project_id)
            ).first()
            if project:
                session.delete(project)

            session.commit()

        if self.selected_project_id == project_id:
            self.selected_project_id = None
            self.selected_project_name = ""
            self.selected_project_path = ""
            self.image_files = []
            self.image_labels = {}
            self.current_image_index = 0

        self.load_projects()

    def select_project(self, project_id: int):
        """Select a project and load its images."""
        with rx.session() as session:
            project = session.exec(
                Project.select().where(Project.id == project_id)
            ).first()

            if not project:
                return

            # Update last accessed
            project.last_accessed = datetime.now()
            session.add(project)
            session.commit()

            self.selected_project_id = project.id
            self.selected_project_name = project.name
            self.selected_project_path = project.path

        self.scan_images()
        self.load_labels()
        self.current_image_index = 0

    def scan_images(self):
        """Scan the selected project folder for images."""
        if not self.selected_project_path:
            self.image_files = []
            return

        folder = Path(self.selected_project_path)
        if not folder.exists():
            self.image_files = []
            return

        self.image_files = sorted([
            f.name
            for f in folder.iterdir()
            if f.is_file() and f.suffix.lower() in SUPPORTED_EXTENSIONS
        ])

    def load_labels(self):
        """Load labels for current project from database."""
        if not self.selected_project_id:
            self.image_labels = {}
            return

        with rx.session() as session:
            labels = session.exec(
                ImageLabel.select().where(
                    ImageLabel.project_id == self.selected_project_id
                )
            ).all()
            self.image_labels = {l.filename: l.label for l in labels}

    # Labeling actions
    def apply_label(self, label: str):
        """Apply a label to the current image and save to database."""
        if not self.current_image_filename or not self.selected_project_id:
            return

        filename = self.current_image_filename

        with rx.session() as session:
            # Check if label exists
            existing = session.exec(
                ImageLabel.select().where(
                    ImageLabel.project_id == self.selected_project_id,
                    ImageLabel.filename == filename,
                )
            ).first()

            if existing:
                existing.label = label
                existing.updated_at = datetime.now()
                session.add(existing)
            else:
                new_label = ImageLabel(
                    project_id=self.selected_project_id,
                    filename=filename,
                    label=label,
                    created_at=datetime.now(),
                    updated_at=datetime.now(),
                )
                session.add(new_label)

            session.commit()

        # Update local cache
        self.image_labels = {**self.image_labels, filename: label}

        # Auto-advance to next image
        if self.current_image_index < len(self.image_files) - 1:
            self.current_image_index += 1

    def clear_label(self):
        """Remove label from current image."""
        if not self.current_image_filename or not self.selected_project_id:
            return

        filename = self.current_image_filename

        with rx.session() as session:
            existing = session.exec(
                ImageLabel.select().where(
                    ImageLabel.project_id == self.selected_project_id,
                    ImageLabel.filename == filename,
                )
            ).first()
            if existing:
                session.delete(existing)
                session.commit()

        # Update local cache
        if filename in self.image_labels:
            new_labels = {k: v for k, v in self.image_labels.items() if k != filename}
            self.image_labels = new_labels

    # Navigation
    def next_image(self):
        if self.current_image_index < len(self.image_files) - 1:
            self.current_image_index += 1

    def prev_image(self):
        if self.current_image_index > 0:
            self.current_image_index -= 1

    def go_to_image(self, index: int):
        if 0 <= index < len(self.image_files):
            self.current_image_index = index

    async def handle_folder_drop(self, files: list[rx.UploadFile]):
        """Handle drag and drop of files - extract folder path from first file."""
        if not files:
            return

        # Get the first file to extract path info
        first_file = files[0]

        # The filename from browser might contain relative path for folder uploads
        # Try to extract folder path
        filename = first_file.filename

        # For folder uploads, the filename might be like "folder/subfolder/file.jpg"
        # We'll save to a temp location and try to identify the source folder
        # Note: Browsers don't expose full local paths for security

        # For now, just read the file to get any available path info
        # If user dropped files from a folder, set a message
        if "/" in filename:
            # Has subfolder structure - use the root folder name
            folder_name = filename.split("/")[0]
            self.folder_input = f"Dropped: {folder_name} (enter full path manually)"
        else:
            self.folder_input = f"Dropped file: {filename} (enter folder path manually)"
