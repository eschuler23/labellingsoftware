"""Image viewer component for displaying and browsing images."""

import reflex as rx

from ..state import AppState


def image_viewer() -> rx.Component:
    """Main image viewing area."""
    return rx.box(
        rx.cond(
            AppState.has_project_selected,
            rx.cond(
                AppState.total_images > 0,
                # Show image
                rx.vstack(
                    # Progress bar
                    rx.hstack(
                        rx.text(AppState.progress_text, size="2", weight="medium"),
                        rx.spacer(),
                        rx.text(AppState.labeled_text, size="2", color="gray"),
                        width="100%",
                    ),
                    rx.progress(value=AppState.progress_percent, width="100%"),
                    # Image display
                    rx.box(
                        rx.image(
                            src=AppState.current_image_url,
                            max_height="55vh",
                            max_width="100%",
                            object_fit="contain",
                            border_radius="md",
                        ),
                        width="100%",
                        min_height="350px",
                        display="flex",
                        align_items="center",
                        justify_content="center",
                        background="var(--gray-2)",
                        border_radius="lg",
                    ),
                    # Filename and current label
                    rx.hstack(
                        rx.text(AppState.current_image_filename, size="2", color="gray"),
                        rx.spacer(),
                        rx.cond(
                            AppState.current_image_label != "",
                            rx.badge(
                                AppState.current_image_label,
                                color_scheme="green",
                                size="2",
                            ),
                            rx.badge("Unlabeled", color_scheme="gray", variant="soft", size="2"),
                        ),
                        width="100%",
                    ),
                    width="100%",
                    spacing="3",
                ),
                # No images in folder
                rx.center(
                    rx.vstack(
                        rx.icon("image-off", size=48, color="gray"),
                        rx.text("No images found in this folder", size="3", color="gray"),
                        rx.text("Supported formats: JPG, PNG, GIF, BMP, WebP", size="2", color="gray"),
                        align="center",
                        spacing="2",
                    ),
                    height="400px",
                ),
            ),
            # No project selected
            rx.center(
                rx.vstack(
                    rx.icon("folder-open", size=64, color="gray"),
                    rx.text("Select a project from the sidebar", size="4", color="gray"),
                    rx.text("or click + to add a new folder", size="2", color="gray"),
                    align="center",
                    spacing="2",
                ),
                height="400px",
            ),
        ),
        width="100%",
        padding="4",
    )
