# Scan

A private document scanner that runs entirely in your browser. Point your camera at a document, get automatic edge detection and perspective correction, then export as JPEG, PNG, WebP, or PDF — no server upload required.

## Features

- Live document edge detection using OpenCV.js
- Automatic perspective correction (warp to a flat rectangle)
- Color and black & white enhancement modes
- Rotate, export, share, and copy scanned pages
- Multi-page PDF export
- Installable as a PWA (works offline)
- English, Portuguese, and Spanish translations

## Running locally

```bash
python3 serve.py 8000
```

Then open `http://localhost:8000/index.html` in your browser.

To preview the switch-camera button with one camera, open `http://localhost:8000/index.html?showCameraSwitch=1` and turn on the camera. This parameter works only on localhost or loopback addresses; switching still requires multiple cameras.

## Tech

Vanilla HTML/CSS/JS, [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html) for image processing, [pdf-lib](https://pdf-lib.js.org/) for PDF export.

## License

MIT — see [LICENSE](LICENSE).
