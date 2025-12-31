"""Sidebar component showing project list."""

import reflex as rx

from ..state import AppState


def project_item(project: dict) -> rx.Component:
    """Single project item in the sidebar."""
    return rx.hstack(
        rx.icon("folder", size=18),
        rx.text(project["name"], size="2", weight="medium"),
        rx.spacer(),
        rx.icon_button(
            rx.icon("trash-2", size=14),
            size="1",
            variant="ghost",
            color_scheme="red",
            on_click=lambda: AppState.remove_project(project["id"]),
        ),
        padding="3",
        width="100%",
        border_radius="md",
        cursor="pointer",
        background=rx.cond(
            AppState.selected_project_id == project["id"],
            "var(--accent-4)",
            "transparent",
        ),
        _hover={"background": "var(--gray-4)"},
        on_click=lambda: AppState.select_project(project["id"]),
    )


def sidebar() -> rx.Component:
    """Project sidebar component."""
    return rx.box(
        rx.vstack(
            # Header
            rx.hstack(
                rx.hstack(
                    rx.icon("image", size=24),
                    rx.heading("Labeler", size="5", weight="bold"),
                    spacing="2",
                    align="center",
                ),
                rx.spacer(),
                rx.icon_button(
                    rx.icon("folder-plus", size=18),
                    size="2",
                    variant="soft",
                    on_click=AppState.toggle_add_folder_dialog,
                ),
                width="100%",
                padding="4",
            ),
            rx.divider(),
            # Project list
            rx.vstack(
                rx.text("Projects", size="1", color="gray", weight="medium"),
                rx.cond(
                    AppState.projects.length() > 0,
                    rx.scroll_area(
                        rx.vstack(
                            rx.foreach(AppState.projects, project_item),
                            spacing="1",
                            width="100%",
                        ),
                        height="calc(100vh - 200px)",
                        width="100%",
                    ),
                    rx.center(
                        rx.vstack(
                            rx.icon("folder-open", size=32, color="gray"),
                            rx.text("No projects yet", size="2", color="gray"),
                            rx.text("Click + to add a folder", size="1", color="gray"),
                            align="center",
                            spacing="2",
                        ),
                        height="200px",
                    ),
                ),
                spacing="2",
                padding="3",
                width="100%",
                align="start",
            ),
            rx.spacer(),
            # Footer
            rx.vstack(
                rx.divider(),
                rx.hstack(
                    rx.text("Theme", size="2", color="gray"),
                    rx.spacer(),
                    rx.color_mode.button(size="1"),
                    width="100%",
                    padding="3",
                ),
                width="100%",
            ),
            height="100%",
            width="100%",
            spacing="0",
        ),
        width="240px",
        min_width="240px",
        height="100vh",
        border_right="1px solid var(--gray-5)",
        background="var(--gray-1)",
    )
