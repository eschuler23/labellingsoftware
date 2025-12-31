"""Dialog for adding a new folder/project."""

import reflex as rx

from ..state import AppState


def add_folder_dialog() -> rx.Component:
    """Modal dialog for adding a new folder as a project."""
    return rx.dialog.root(
        rx.dialog.content(
            rx.dialog.title("Add Folder"),
            rx.dialog.description(
                "Enter the full path to a folder containing images.",
                size="2",
            ),
            rx.vstack(
                rx.input(
                    placeholder="/path/to/your/images",
                    value=AppState.folder_input,
                    on_change=AppState.set_folder_input,
                    width="100%",
                    size="3",
                ),
                rx.text(
                    "Tip: Drag a folder from Finder into Terminal to get the path, then paste here.",
                    size="1",
                    color="gray",
                ),
                rx.text(
                    "Supported formats: JPG, PNG, GIF, BMP, WebP",
                    size="1",
                    color="gray",
                ),
                rx.hstack(
                    rx.dialog.close(
                        rx.button(
                            "Cancel",
                            variant="soft",
                            color_scheme="gray",
                            on_click=AppState.toggle_add_folder_dialog,
                        ),
                    ),
                    rx.button(
                        "Add Folder",
                        on_click=AppState.add_project,
                    ),
                    spacing="3",
                    justify="end",
                    width="100%",
                ),
                spacing="4",
                width="100%",
                padding_top="4",
            ),
            max_width="450px",
        ),
        open=AppState.show_add_folder_dialog,
        on_open_change=lambda _: AppState.toggle_add_folder_dialog(),
    )
