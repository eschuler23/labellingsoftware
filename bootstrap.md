# Bootstrap Options for Image Labeling Software

Based on the requirements:
1. Display one image at a time from selected folder
2. Buttons below image with labels
3. Export image name + label to CSV

## Recommended Options

### Best Fit: Simple Python/Tkinter Tools

These are the closest match to our simple requirements:

| Repo | Description | Why It Fits |
|------|-------------|-------------|
| [imgLabel](https://github.com/coding-ai/imgLabel) | Python + Tkinter image labeling tool | Simple, outputs to CSV, minimal dependencies |
| [image-labeling (imankarimi)](https://github.com/imankarimi/image-labeling) | Desktop app with predefined labels | Clean UI, auto-renaming, custom directories |

### Web-Based Alternatives

If a browser-based UI is preferred:

| Repo | Description | Stack |
|------|-------------|-------|
| [make-sense](https://github.com/SkalskiP/make-sense) | Free online photo labeling tool | React, runs in browser |
| [react-image-annotate](https://github.com/UniversalDataTool/react-image-annotate) | Classify/tag images with buttons | React component |
| [image-labelling-tool](https://github.com/yuyu2172/image-labelling-tool) | Flask-based web app | Python + Flask |

### Full-Featured (Overkill but Good Reference)

| Repo | Description | Notes |
|------|-------------|-------|
| [Label Studio](https://github.com/HumanSignal/label-studio) | Industry-standard labeling platform | Feature-rich, may be overkill for our needs |
| [CVAT](https://github.com/opencv/cvat) | Intel's annotation tool | Powerful but complex |
| [LabelImg](https://github.com/HumanSignal/labelImg) | Classic image annotation tool | Now part of Label Studio |

## Quick Start Recommendations

### Option A: Fork imgLabel (Fastest)
```bash
git clone https://github.com/coding-ai/imgLabel.git
```
- Already uses Tkinter
- Outputs CSV
- Just needs UI simplification for classification buttons

### Option B: Build from Scratch (Most Control)
Use the [image-labeling tutorial](https://dev.to/imankarimi/efficient-image-labeling-with-python-and-tkinter-a-guide-to-simplifying-dataset-preparation-for-ai-24od) as a guide:
- ~100 lines of Python
- Tkinter for UI
- PIL for image display
- CSV module for export

### Option C: Web-Based with React
Use [react-image-annotate](https://github.com/UniversalDataTool/react-image-annotate) as a starting point:
- npm package available
- Supports classification with buttons
- Would need backend for folder selection/CSV export

## Curated Lists for More Options

- [awesome-data-labeling](https://github.com/HumanSignal/awesome-data-labeling)
- [awesome-open-data-annotation](https://github.com/zenml-io/awesome-open-data-annotation)
- [GitHub: image-labeling topic](https://github.com/topics/image-labeling)
- [GitHub: image-labeling-tool topic](https://github.com/topics/image-labeling-tool)

## Decision Matrix

| Approach | Complexity | Time to MVP | Customization |
|----------|------------|-------------|---------------|
| Fork imgLabel | Low | Hours | Medium |
| Build with Tkinter | Low | 1-2 days | High |
| Web (React + Flask) | Medium | 2-3 days | High |
| Use Label Studio | High | Hours (setup) | Low |
