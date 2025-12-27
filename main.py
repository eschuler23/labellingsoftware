import csv
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox

from PIL import Image, ImageTk


class ImageLabeler:
    SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}
    DEFAULT_LABELS = ["Usable", "Too Blurry", "Wrong Setup", "Not Allowed"]

    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Image Labeler")
        self.root.geometry("800x700")

        self.image_folder: Path | None = None
        self.image_files: list[Path] = []
        self.current_index = 0
        self.labels: list[dict] = []
        self.current_image: ImageTk.PhotoImage | None = None

        self._setup_ui()

    def _setup_ui(self):
        # Top frame for folder selection
        top_frame = tk.Frame(self.root)
        top_frame.pack(pady=10)

        self.folder_btn = tk.Button(
            top_frame, text="Select Folder", command=self._select_folder
        )
        self.folder_btn.pack(side=tk.LEFT, padx=5)

        self.folder_label = tk.Label(top_frame, text="No folder selected")
        self.folder_label.pack(side=tk.LEFT, padx=5)

        # Progress label
        self.progress_label = tk.Label(self.root, text="")
        self.progress_label.pack(pady=5)

        # Image display area
        self.image_frame = tk.Frame(self.root, bg="gray", width=700, height=500)
        self.image_frame.pack(pady=10)
        self.image_frame.pack_propagate(False)

        self.image_label = tk.Label(self.image_frame, bg="gray")
        self.image_label.pack(expand=True)

        # Filename display
        self.filename_label = tk.Label(self.root, text="", font=("Arial", 10))
        self.filename_label.pack(pady=5)

        # Label buttons frame
        self.buttons_frame = tk.Frame(self.root)
        self.buttons_frame.pack(pady=10)

        self._create_label_buttons()

        # Bottom frame for navigation and export
        bottom_frame = tk.Frame(self.root)
        bottom_frame.pack(pady=10)

        self.skip_btn = tk.Button(
            bottom_frame, text="Skip", command=self._skip_image, state=tk.DISABLED
        )
        self.skip_btn.pack(side=tk.LEFT, padx=5)

        self.export_btn = tk.Button(
            bottom_frame, text="Export CSV", command=self._export_csv, state=tk.DISABLED
        )
        self.export_btn.pack(side=tk.LEFT, padx=5)

    def _create_label_buttons(self):
        for widget in self.buttons_frame.winfo_children():
            widget.destroy()

        for label_text in self.DEFAULT_LABELS:
            btn = tk.Button(
                self.buttons_frame,
                text=label_text,
                width=12,
                height=2,
                command=lambda l=label_text: self._apply_label(l),
                state=tk.DISABLED,
            )
            btn.pack(side=tk.LEFT, padx=5)

    def _select_folder(self):
        folder = filedialog.askdirectory(title="Select Image Folder")
        if not folder:
            return

        self.image_folder = Path(folder)
        self.image_files = sorted(
            f for f in self.image_folder.iterdir()
            if f.suffix.lower() in self.SUPPORTED_EXTENSIONS
        )

        if not self.image_files:
            messagebox.showwarning("No Images", "No supported images found in folder.")
            return

        self.folder_label.config(text=self.image_folder.name)
        self.current_index = 0
        self.labels = []

        self._enable_buttons()
        self._show_current_image()

    def _enable_buttons(self):
        for btn in self.buttons_frame.winfo_children():
            btn.config(state=tk.NORMAL)
        self.skip_btn.config(state=tk.NORMAL)
        self.export_btn.config(state=tk.NORMAL)

    def _show_current_image(self):
        if self.current_index >= len(self.image_files):
            self._show_completion()
            return

        image_path = self.image_files[self.current_index]
        self.filename_label.config(text=image_path.name)
        self.progress_label.config(
            text=f"Image {self.current_index + 1} of {len(self.image_files)}"
        )

        try:
            img = Image.open(image_path)
            img.thumbnail((680, 480), Image.Resampling.LANCZOS)
            self.current_image = ImageTk.PhotoImage(img)
            self.image_label.config(image=self.current_image)
        except Exception as e:
            self.image_label.config(image="", text=f"Error loading image:\n{e}")

    def _apply_label(self, label: str):
        if self.current_index >= len(self.image_files):
            return

        image_path = self.image_files[self.current_index]
        self.labels.append({"filename": image_path.name, "label": label})

        self.current_index += 1
        self._show_current_image()

    def _skip_image(self):
        if self.current_index < len(self.image_files):
            self.current_index += 1
            self._show_current_image()

    def _show_completion(self):
        self.image_label.config(image="", text="All images labeled!")
        self.filename_label.config(text="")
        self.progress_label.config(text=f"Labeled: {len(self.labels)} images")

        for btn in self.buttons_frame.winfo_children():
            btn.config(state=tk.DISABLED)
        self.skip_btn.config(state=tk.DISABLED)

    def _export_csv(self):
        if not self.labels:
            messagebox.showinfo("No Labels", "No labels to export yet.")
            return

        output_path = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv")],
            initialfile="labels.csv",
        )

        if not output_path:
            return

        with open(output_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["filename", "label"])
            writer.writeheader()
            writer.writerows(self.labels)

        messagebox.showinfo("Exported", f"Labels exported to:\n{output_path}")


def main():
    root = tk.Tk()
    ImageLabeler(root)
    root.mainloop()


if __name__ == "__main__":
    main()
