from pathlib import Path
from PIL import Image

THUMBNAIL_SIZE = (800, 800)
THUMBNAIL_DIR_NAME = ".thumbnails"

def generate_thumbnail(image_path: Path) -> Path:
    """
    Generates a thumbnail for the given image path.
    Returns the path to the thumbnail.
    """
    thumbnail_dir = image_path.parent / THUMBNAIL_DIR_NAME
    thumbnail_dir.mkdir(parents=True, exist_ok=True)
    
    thumbnail_path = thumbnail_dir / image_path.name
    
    # If thumbnail already exists and is newer than image, skip
    if thumbnail_path.exists() and thumbnail_path.stat().st_mtime > image_path.stat().st_mtime:
        return thumbnail_path

    try:
        with Image.open(image_path) as img:
            img.thumbnail(THUMBNAIL_SIZE)
            # Convert to RGB if necessary (e.g. for PNGs with transparency if saving as JPEG, 
            # but we'll try to keep original format or use JPEG for efficiency)
            # For simplicity, let's save as the original format if possible, or JPEG.
            
            # If we want to enforce compression, we might want to convert to JPEG or WebP.
            # Let's stick to the original format for now but resized.
            
            img.save(thumbnail_path)
    except Exception as e:
        print(f"Error generating thumbnail for {image_path}: {e}")
        return image_path # Fallback to original if failed

    return thumbnail_path

def get_thumbnail_path(image_path: Path) -> Path:
    return image_path.parent / THUMBNAIL_DIR_NAME / image_path.name
