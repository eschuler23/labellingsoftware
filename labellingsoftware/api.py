"""Custom API endpoints for serving images from filesystem."""

import urllib.parse
from pathlib import Path

from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}


async def serve_image_endpoint(request: Request):
    """
    Serve an image from an arbitrary filesystem path.
    Path is URL-encoded to handle spaces and special characters.
    """
    path = request.query_params.get("path", "")
    if not path:
        return JSONResponse({"error": "Missing path parameter"}, status_code=400)

    decoded_path = urllib.parse.unquote(path)
    file_path = Path(decoded_path)

    # Security: resolve to absolute path
    try:
        file_path = file_path.resolve()
    except Exception:
        return JSONResponse({"error": "Invalid path"}, status_code=400)

    # Check file exists
    if not file_path.exists():
        return JSONResponse({"error": "Image not found"}, status_code=404)

    if not file_path.is_file():
        return JSONResponse({"error": "Not a file"}, status_code=400)

    # Check extension
    if file_path.suffix.lower() not in ALLOWED_EXTENSIONS:
        return JSONResponse({"error": "Invalid file type"}, status_code=400)

    # Determine media type
    ext = file_path.suffix.lower().strip(".")
    if ext == "jpg":
        ext = "jpeg"
    media_type = f"image/{ext}"

    return FileResponse(str(file_path), media_type=media_type)
