"""Image Labeling App built with Reflex."""

import csv
from pathlib import Path

import reflex as rx


class State(rx.State):
    """The app state."""

    images: list[str] = []
    current_index: int = 0
    labels: list[dict] = []
    upload_complete: bool = False

    LABEL_OPTIONS: list[str] = ["Usable", "Too Blurry", "Wrong Setup", "Not Allowed"]

    @rx.var
    def current_filename(self) -> str:
        """Get the current image filename."""
        if not self.images or self.current_index >= len(self.images):
            return ""
        return self.images[self.current_index]

    @rx.var
    def progress_text(self) -> str:
        """Get progress text."""
        if not self.images:
            return "No images uploaded"
        if self.current_index >= len(self.images):
            return f"Complete! Labeled {len(self.labels)} of {len(self.images)} images"
        return f"Image {self.current_index + 1} of {len(self.images)}"

    @rx.var
    def is_complete(self) -> bool:
        """Check if all images are labeled."""
        return len(self.images) > 0 and self.current_index >= len(self.images)

    @rx.var
    def has_images(self) -> bool:
        """Check if there are images to label."""
        return len(self.images) > 0 and self.current_index < len(self.images)

    @rx.var
    def has_labels(self) -> bool:
        """Check if any labels have been applied."""
        return len(self.labels) > 0

    async def handle_upload(self, files: list[rx.UploadFile]):
        """Handle the upload of image files."""
        for file in files:
            upload_data = await file.read()
            outfile = rx.get_upload_dir() / file.filename

            with outfile.open("wb") as file_object:
                file_object.write(upload_data)

            self.images.append(file.filename)

        self.upload_complete = True

    def apply_label(self, label: str):
        """Apply a label to the current image."""
        if self.current_index >= len(self.images):
            return

        self.labels.append({
            "filename": self.images[self.current_index],
            "label": label,
        })
        self.current_index += 1

    def skip_image(self):
        """Skip the current image without labeling."""
        if self.current_index < len(self.images):
            self.current_index += 1

    def go_back(self):
        """Go back to the previous image."""
        if self.current_index > 0:
            self.current_index -= 1
            # Remove the last label if we're going back
            if self.labels and self.labels[-1]["filename"] == self.images[self.current_index]:
                self.labels.pop()

    def clear_all(self):
        """Reset the app state."""
        self.images = []
        self.current_index = 0
        self.labels = []
        self.upload_complete = False

    def export_csv(self):
        """Export labels to CSV file."""
        if not self.labels:
            return

        output_path = rx.get_upload_dir() / "labels.csv"
        with open(output_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["filename", "label"])
            writer.writeheader()
            writer.writerows(self.labels)

        return rx.download(url=rx.get_upload_url("labels.csv"))


def label_button(label: str) -> rx.Component:
    """Create a label button."""
    colors = {
        "Usable": "green",
        "Too Blurry": "orange",
        "Wrong Setup": "blue",
        "Not Allowed": "red",
    }
    return rx.button(
        label,
        size="3",
        color_scheme=colors.get(label, "gray"),
        on_click=State.apply_label(label),
        disabled=~State.has_images,
        style={"min_width": "140px"},
    )


def upload_area() -> rx.Component:
    """Create the upload area."""
    return rx.vstack(
        rx.upload(
            rx.vstack(
                rx.icon("upload", size=48, color="gray"),
                rx.text("Drag & drop images here", size="4", color="gray"),
                rx.text("or click to select", size="2", color="gray"),
                align="center",
                spacing="2",
            ),
            id="image_upload",
            multiple=True,
            accept={"image/*": [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]},
            border="2px dashed #ccc",
            border_radius="lg",
            padding="8",
            width="100%",
            min_height="200px",
            display="flex",
            align_items="center",
            justify_content="center",
            _hover={"border_color": "blue", "cursor": "pointer"},
        ),
        rx.hstack(
            rx.text(rx.selected_files("image_upload"), size="2", color="gray"),
            width="100%",
        ),
        rx.button(
            "Upload Images",
            size="3",
            on_click=State.handle_upload(rx.upload_files(upload_id="image_upload")),
        ),
        width="100%",
        max_width="600px",
        spacing="4",
        align="center",
    )


def labeling_area() -> rx.Component:
    """Create the main labeling interface."""
    return rx.vstack(
        # Progress
        rx.hstack(
            rx.text(State.progress_text, size="3", weight="medium"),
            rx.spacer(),
            rx.button(
                "Start Over",
                size="1",
                variant="ghost",
                color_scheme="gray",
                on_click=State.clear_all,
            ),
            width="100%",
        ),
        # Image display
        rx.box(
            rx.cond(
                State.has_images,
                rx.image(
                    src=rx.get_upload_url(State.current_filename),
                    max_height="500px",
                    max_width="100%",
                    object_fit="contain",
                    border_radius="md",
                ),
                rx.cond(
                    State.is_complete,
                    rx.vstack(
                        rx.icon("circle-check", size=64, color="green"),
                        rx.text("All images labeled!", size="5", weight="bold"),
                        rx.text(f"Labeled {State.labels.length()} images", size="3", color="gray"),
                        align="center",
                        spacing="3",
                    ),
                    rx.text("No images", color="gray"),
                ),
            ),
            min_height="400px",
            width="100%",
            display="flex",
            align_items="center",
            justify_content="center",
            background="var(--gray-2)",
            border_radius="lg",
        ),
        # Filename
        rx.text(State.current_filename, size="2", color="gray"),
        # Label buttons
        rx.hstack(
            label_button("Usable"),
            label_button("Too Blurry"),
            label_button("Wrong Setup"),
            label_button("Not Allowed"),
            spacing="3",
            wrap="wrap",
            justify="center",
        ),
        # Navigation
        rx.hstack(
            rx.button(
                rx.icon("arrow-left", size=16),
                "Back",
                size="2",
                variant="soft",
                on_click=State.go_back,
                disabled=State.current_index <= 0,
            ),
            rx.button(
                "Skip",
                rx.icon("arrow-right", size=16),
                size="2",
                variant="soft",
                on_click=State.skip_image,
                disabled=~State.has_images,
            ),
            rx.spacer(),
            rx.button(
                rx.icon("download", size=16),
                "Export CSV",
                size="2",
                color_scheme="green",
                on_click=State.export_csv,
                disabled=~State.has_labels,
            ),
            width="100%",
        ),
        width="100%",
        max_width="800px",
        spacing="4",
        padding="4",
    )


def index() -> rx.Component:
    """Main page."""
    return rx.center(
        rx.vstack(
            rx.color_mode.button(position="fixed", top="4", right="4"),
            rx.heading("Image Labeler", size="7", margin_bottom="4"),
            rx.cond(
                State.upload_complete,
                labeling_area(),
                upload_area(),
            ),
            spacing="4",
            align="center",
            padding="8",
            width="100%",
        ),
        min_height="100vh",
    )


app = rx.App(
    theme=rx.theme(
        accent_color="blue",
        radius="medium",
    )
)
app.add_page(index, title="Image Labeler")
