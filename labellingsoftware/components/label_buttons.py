"""Label buttons and navigation controls."""

import reflex as rx

from ..state import AppState, LABEL_OPTIONS


def label_button(label: str, index: int) -> rx.Component:
    """Single label button with keyboard shortcut hint."""
    # Color schemes for different labels
    color_schemes = {
        "Usable": "green",
        "Too Blurry": "orange",
        "Wrong Setup": "red",
        "Irrelevant": "gray",
    }
    color = color_schemes.get(label, "blue")

    return rx.button(
        rx.hstack(
            rx.text(label, weight="medium"),
            rx.badge(str(index + 1), variant="soft", size="1"),
            spacing="2",
            align="center",
        ),
        color_scheme=color,
        variant=rx.cond(
            AppState.current_image_label == label,
            "solid",
            "soft",
        ),
        size="3",
        width="100%",
        on_click=lambda: AppState.apply_label(label),
    )


def label_buttons() -> rx.Component:
    """Label buttons and navigation controls."""
    return rx.vstack(
        # Label buttons
        rx.vstack(
            rx.text("Labels", size="2", weight="medium", color="gray"),
            rx.vstack(
                *[label_button(label, i) for i, label in enumerate(LABEL_OPTIONS)],
                spacing="2",
                width="100%",
            ),
            rx.cond(
                AppState.current_image_label != "",
                rx.button(
                    rx.hstack(
                        rx.icon("x", size=16),
                        rx.text("Clear Label"),
                        spacing="2",
                    ),
                    variant="ghost",
                    color_scheme="gray",
                    size="2",
                    width="100%",
                    on_click=AppState.clear_label,
                ),
                rx.box(),
            ),
            spacing="2",
            width="100%",
        ),
        rx.divider(),
        # Navigation
        rx.vstack(
            rx.text("Navigation", size="2", weight="medium", color="gray"),
            rx.hstack(
                rx.button(
                    rx.icon("chevron-left", size=20),
                    variant="soft",
                    size="3",
                    on_click=AppState.prev_image,
                    disabled=AppState.current_image_index <= 0,
                ),
                rx.center(
                    rx.text(
                        AppState.progress_text,
                        size="2",
                        weight="medium",
                    ),
                    flex="1",
                ),
                rx.button(
                    rx.icon("chevron-right", size=20),
                    variant="soft",
                    size="3",
                    on_click=AppState.next_image,
                    disabled=AppState.current_image_index >= AppState.total_images - 1,
                ),
                width="100%",
                spacing="2",
            ),
            rx.text(
                "Use arrow keys ← → to navigate",
                size="1",
                color="gray",
                text_align="center",
            ),
            spacing="2",
            width="100%",
        ),
        spacing="4",
        width="100%",
        padding="4",
    )
