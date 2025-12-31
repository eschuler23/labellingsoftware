"""Image Labeling App built with Reflex."""

import reflex as rx

from .api import serve_image_endpoint as serve_image
from .components import add_folder_dialog, image_viewer, label_buttons, sidebar
from .state import AppState


def index() -> rx.Component:
    """Main page with sidebar layout."""
    return rx.hstack(
        # Sidebar
        sidebar(),
        # Main content area
        rx.box(
            rx.vstack(
                # Header
                rx.hstack(
                    rx.heading(
                        rx.cond(
                            AppState.has_project_selected,
                            AppState.selected_project_name,
                            "Image Labeler",
                        ),
                        size="6",
                    ),
                    rx.spacer(),
                    width="100%",
                    padding="4",
                    border_bottom="1px solid var(--gray-5)",
                ),
                # Main content - centered
                rx.center(
                    rx.hstack(
                        # Image viewer (center)
                        rx.box(
                            image_viewer(),
                            flex="1",
                            max_width="800px",
                        ),
                        # Label controls (right side)
                        rx.cond(
                            AppState.has_project_selected & (AppState.total_images > 0),
                            rx.box(
                                label_buttons(),
                                width="280px",
                                min_width="280px",
                                border_left="1px solid var(--gray-5)",
                            ),
                            rx.box(),
                        ),
                        spacing="4",
                        align="start",
                    ),
                    width="100%",
                    height="calc(100vh - 73px)",
                    overflow="auto",
                    padding="4",
                ),
                spacing="0",
                height="100vh",
                width="100%",
            ),
            flex="1",
        ),
        # Add folder dialog
        add_folder_dialog(),
        spacing="0",
        width="100%",
        height="100vh",
        overflow="hidden",
    )


app = rx.App(
    theme=rx.theme(
        accent_color="blue",
        radius="medium",
    ),
)

# Add the main page
app.add_page(
    index,
    title="Image Labeler",
    on_load=AppState.on_load,
)

# Register the API endpoint for serving images
from starlette.routing import Route
app._api.routes.append(Route("/_image", serve_image, methods=["GET"]))
