"""Audit an exported training bundle using only the Python standard library.

Counts are recomputed from saved predictions, without rerunning the detector.
This does not evaluate video tracking or distinct visitor counts.
"""

import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path
from statistics import mean


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def audit(root, output):
    root = root.resolve()
    output.mkdir(parents=True, exist_ok=True)
    failures = []
    manifest = read_csv(root / "manifest.csv")
    for entry in manifest:
        path = (root / entry["file"]).resolve()
        if not path.is_relative_to(root):
            raise ValueError(f"Unsafe manifest path: {entry['file']}")
        if not path.is_file():
            failures.append({"file": entry["file"], "reason": "missing"})
            continue
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if path.stat().st_size != int(entry["bytes"]) or digest != entry["sha256"]:
            failures.append({"file": entry["file"], "reason": "size or hash mismatch"})
    if failures:
        raise ValueError(f"Manifest verification failed: {failures}")

    model_info = json.loads((root / "report/model_info.json").read_text(encoding="utf-8"))
    if model_info["classes"] != {"0": "person"}:
        raise ValueError("This count audit requires a single person class.")
    duplicates = json.loads((root / "report/cross_split_duplicates.json").read_text(encoding="utf-8"))
    duplicate_names = {Path(name).name for group in duplicates for _, name in group["files"]}
    duplicate_pairs = Counter("+".join(sorted(group["splits"])) for group in duplicates)
    images = read_csv(root / "report/dataset_images.csv")
    reference = json.loads((root / "report/confidence_reference_val.json").read_text(encoding="utf-8"))
    thresholds = [0.25, float(reference["confidence"])]
    rows, summaries = [], []
    for split in ("val", "test"):
        truth = {Path(row["image"]).name: int(row["boxes"]) for row in images if row["split"] == split}
        predictions = json.loads((root / f"evaluation/best_{split}/predictions.json").read_text(encoding="utf-8"))
        # The exported COCO JSON uses category_id=1 for model class 0.
        if {p["category_id"] for p in predictions} != {1}:
            raise ValueError("Unexpected COCO category IDs.")
        if any(p["file_name"] not in truth for p in predictions):
            raise ValueError("Prediction filename missing from dataset image inventory.")
        for threshold in thresholds:
            counts = Counter(p["file_name"] for p in predictions if p["score"] >= threshold)
            current = [
                {"split": split, "confidence": threshold, "image": name,
                 "ground_truth_count": actual, "predicted_count": counts[name],
                 "error": counts[name] - actual,
                 "in_recorded_cross_split_duplicate": name in duplicate_names}
                for name, actual in truth.items()
            ]
            rows.extend(current)
            summaries.append({
                "split": split, "confidence": threshold, "images": len(current),
                "ground_truth_people": sum(truth.values()),
                "predicted_people": sum(counts.values()),
                "count_mae": mean(abs(r["error"]) for r in current),
                "count_rmse": mean(r["error"] ** 2 for r in current) ** 0.5,
                "exact_count_fraction": mean(r["error"] == 0 for r in current),
                "undercount_images": sum(r["error"] < 0 for r in current),
                "overcount_images": sum(r["error"] > 0 for r in current),
                "max_absolute_error": max(abs(r["error"]) for r in current),
            })
    result = {
        "method": "Offline analysis of saved best-checkpoint detections; no fresh inference or video run.",
        "limitations": [
            "Equal counts do not establish correct boxes: false positives and misses can cancel out.",
            "Cross-split duplicate groups and possible adjacent video frames limit independence.",
            "No tracking IDs, video timestamps, temporal stability or distinct visitor counts evaluated.",
            "Thresholds are fixed at 0.25 and the saved validation F1 reference; not optimized on test.",
            "Zero background-only images in the recorded splits; empty-scene behavior is untested.",
        ],
        "manifest_files_verified": len(manifest), "manifest_failures": failures,
        "model": model_info["architecture"],
        "cross_split_duplicate_groups": len(duplicates),
        "duplicate_split_pairs": dict(duplicate_pairs), "count_metrics": summaries,
    }
    (output / "artifact_audit.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with (output / "per_image_counts.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts/cctv_yolov8n_v5"))
    parser.add_argument("--output", type=Path, default=Path("audit"))
    args = parser.parse_args()
    audit(args.artifacts, args.output)
