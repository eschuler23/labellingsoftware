"""Database models for the image labeling application."""

from datetime import datetime
from typing import Optional

import reflex as rx
from sqlmodel import Field


class Project(rx.Model, table=True):
    """Represents a folder/project containing images to label."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str  # Display name (folder basename)
    path: str  # Absolute filesystem path to folder
    created_at: datetime = Field(default_factory=datetime.now)
    last_accessed: datetime = Field(default_factory=datetime.now)


class ImageLabel(rx.Model, table=True):
    """Stores labels for individual images within a project."""

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int  # Foreign key to Project
    filename: str  # Image filename (not full path)
    label: str  # One of: Usable, Too Blurry, Wrong Setup, Irrelevant
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
