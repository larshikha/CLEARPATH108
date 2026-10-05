"""Train Phase 3 forests and export portable JSON models.

Runtime CLEARPATH action selection stays on the placeholder policy until Phase 4.
"""
import csv
import json
import random
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import (accuracy_score, classification_report,
                             confusion_matrix, mean_absolute_error, r2_score)

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "web" / "public" / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)
LABELS = ["LEFT", "NONE", "RIGHT", "STOP"]
MOVE_FEATURES = [
    "dist_to_amb", "lane_offset", "same_lane", "lane_idx", "n_lanes",
    "is_oneway", "has_median", "has_shoulder", "junction_dist",
    "free_left", "free_right", "veh_speed", "amb_speed", "density", "oncoming",
]
CORRIDOR_FEATURES = ["amb_speed", "density", "road_type_code", "n_lanes", "slower_ahead_150m"]
ETA_FEATURES = ["remaining_dist", "amb_speed", "density", "road_type_code", "slower_ahead_150m"]


def read_rows(path):
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def matrix(rows, features):
    return [[float(row[name]) for name in features] for row in rows]


def print_balance(rows, title):
    counts = Counter(row["action"] for row in rows)
    print(f"{title} class balance (n={len(rows)}):")
    for label in LABELS:
        count = counts[label]
        print(f"  {label}: {count} ({100 * count / len(rows):.2f}%)" if rows else f"  {label}: 0 (0.00%)")
    return counts


def report_group(model, rows, title):
    if not rows:
        print(f"\n{title}: no rows")
        return None
    expected = [row["action"] for row in rows]
    predicted = model.predict(matrix(rows, MOVE_FEATURES))
    labels = [label for label in LABELS if label in expected or label in model.classes_]
    print(f"\n{title} (n={len(rows)}): accuracy={accuracy_score(expected, predicted):.4f}")
    print(classification_report(expected, predicted, labels=labels, zero_division=0))
    print("confusion matrix labels:", labels)
    print(confusion_matrix(expected, predicted, labels=labels))
    return accuracy_score(expected, predicted)


def export_forest(model, features, kind, classes=None):
    trees = []
    for estimator in model.estimators_:
        tree = estimator.tree_
        trees.append({
            "left": tree.children_left.tolist(),
            "right": tree.children_right.tolist(),
            "feature": tree.feature.tolist(),
            "threshold": tree.threshold.tolist(),
            "value": tree.value[:, 0, :].tolist(),
        })
    return {"kind": kind, "features": features, "classes": classes, "trees": trees}


def stratified_match_samples(rows, model, wanted=200):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["road_type"], row["action"])].append(row)
    rng = random.Random(1901)
    keys = sorted(groups)
    base, extra = divmod(wanted, len(keys))
    selected = []
    remaining = []
    for index, key in enumerate(keys):
        group = groups[key][:]
        rng.shuffle(group)
        quota = base + (1 if index < extra else 0)
        selected.extend(group[:quota])
        remaining.extend(group[quota:])
    rng.shuffle(remaining)
    selected = selected[:wanted]
    if len(selected) < wanted:
        selected.extend(remaining[:wanted - len(selected)])
    # The JSON records float32 inputs so the JS Math.fround evaluation is compared
    # with scikit-learn receiving the identical feature values.
    vectors = [[float(np.float32(row[name])) for name in MOVE_FEATURES] for row in selected]
    predictions = model.predict(vectors)
    probabilities = model.predict_proba(vectors)
    samples = []
    for row, vector, expected, probas in zip(selected, vectors, predictions, probabilities):
        samples.append({
            "features": vector,
            "expected": str(expected),
            "probabilities": {str(label): float(value) for label, value in zip(model.classes_, probas)},
            "road_type": row["road_type"],
            "action": row["action"],
        })
    return samples


train_move = read_rows(ROOT / "data" / "train" / "move_side.csv")
test_move = read_rows(ROOT / "data" / "test" / "move_side.csv")
assert all(row["road_type"] != "twoway" for row in train_move + test_move), "twoway must be excluded"
for category in ["DECISION", "OTHER", "ONCOMING", "JUNCTION_CROSS"]:
    print_balance([row for row in train_move if row["row_type"] == category], f"Training {category}")
all_counts = print_balance(train_move, "Training retained move_side rows")
rare = [label for label in ("NONE", "STOP") if all_counts[label] / len(train_move) < 0.05]
if rare:
    raise SystemExit("Training stopped: " + ", ".join(rare) + " below 5%")

decision_train = [row for row in train_move if row["row_type"] == "DECISION"]
decision_counts = Counter(row["action"] for row in decision_train)
decision_stop_share = decision_counts["STOP"] / len(decision_train) if decision_train else 0
# Junction-cross STOP remains in the dataset and is handled by the explicit
# runtime junction rule. If main-road STOP is <1% of DECISION rows, omit STOP
# from the forest target classes as requested.
drop_stop_class = decision_stop_share < 0.01
classifier_rows = [row for row in train_move if not (drop_stop_class and row["action"] == "STOP")]
print(f"DECISION STOP share: {decision_counts['STOP']}/{len(decision_train)} ({100 * decision_stop_share:.3f}%); "
      f"drop STOP forest class: {drop_stop_class}")
move_model = RandomForestClassifier(n_estimators=30, max_depth=8, random_state=314159,
                                    class_weight=None, n_jobs=-1)
move_model.fit(matrix(classifier_rows, MOVE_FEATURES), [row["action"] for row in classifier_rows])
metrics = {"move_side": {"decision_stop_share": decision_stop_share,
                         "stop_class_dropped": drop_stop_class,
                         "classifier_training_rows": len(classifier_rows)}}
decision_test = [row for row in test_move if row["row_type"] == "DECISION"]
metrics["move_side"]["decision_accuracy"] = report_group(move_model, decision_test, "Held-out DECISION rows (same-lane main-road)")
majority_action = max(LABELS, key=lambda label: decision_counts[label])
majority_accuracy = sum(row["action"] == majority_action for row in decision_test) / len(decision_test)
print(f"DECISION majority-class baseline: {majority_action} ({decision_counts[majority_action]} / {len(decision_train)} train rows); held-out accuracy={majority_accuracy:.4f}")
metrics["move_side"]["decision_majority_action"] = majority_action
metrics["move_side"]["decision_majority_accuracy"] = majority_accuracy
road_accuracies = {}
for road in ["multilane", "divided", "junction"]:
    road_rows = [row for row in decision_test if row["road_type"] == road]
    road_accuracies[road] = report_group(move_model, road_rows, f"Held-out DECISION rows by road: {road}")
metrics["move_side"]["decision_accuracy_by_road"] = road_accuracies
for category in ["OTHER", "ONCOMING", "JUNCTION_CROSS"]:
    subset = [row for row in test_move if row["row_type"] == category]
    print_balance(subset, f"Held-out {category}")
    if category == "JUNCTION_CROSS" and drop_stop_class:
        print("Held-out JUNCTION_CROSS model accuracy: skipped; runtime junction rule retains STOP/NONE behavior.")
        metrics["move_side"]["junction_cross_accuracy"] = None
    else:
        metrics["move_side"][f"{category.lower()}_accuracy"] = report_group(move_model, subset, f"Held-out {category}")

importance = sorted(zip(MOVE_FEATURES, move_model.feature_importances_), key=lambda item: item[1], reverse=True)
print("\nMove-side feature importances:")
for feature, value in importance:
    print(f"  {feature}: {value:.6f}")
metrics["move_side"]["feature_importances"] = {name: float(value) for name, value in importance}
metrics["move_side"]["classes"] = [str(label) for label in move_model.classes_]
move_payload = export_forest(move_model, MOVE_FEATURES, "classifier", [str(c) for c in move_model.classes_])
(MODEL_DIR / "move_side.json").write_text(json.dumps(move_payload, separators=(",", ":")), encoding="utf-8")

for name, features, target, model_cls in [
    ("corridor", CORRIDOR_FEATURES, "corridor_len", RandomForestRegressor),
    ("eta", ETA_FEATURES, "actual_time_to_go", RandomForestRegressor),
]:
    train_rows = read_rows(ROOT / "data" / "train" / f"{name}.csv")
    test_rows = read_rows(ROOT / "data" / "test" / f"{name}.csv")
    assert all(row["road_type"] != "twoway" for row in train_rows + test_rows), "twoway must be excluded"
    model = model_cls(n_estimators=30, max_depth=8, random_state=314159, n_jobs=-1)
    model.fit(matrix(train_rows, features), [float(row[target]) for row in train_rows])
    expected = [float(row[target]) for row in test_rows]
    predicted = model.predict(matrix(test_rows, features))
    mae = mean_absolute_error(expected, predicted)
    r2 = r2_score(expected, predicted)
    print(f"\n{name} held-out test seeds 1001-1100: MAE={mae:.4f}, R2={r2:.4f}")
    metrics[name] = {"mae": mae, "r2": r2}
    payload = export_forest(model, features, "regressor")
    (MODEL_DIR / f"{name}.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

samples = stratified_match_samples(test_move, move_model, 200)
(MODEL_DIR / "forest_match_samples.json").write_text(json.dumps(samples, separators=(",", ":")), encoding="utf-8")
sample_balance = Counter((row["road_type"], row["action"]) for row in samples)
print(f"\nForest parity sample: {len(samples)} rows stratified by road type and class:")
for key, count in sorted(sample_balance.items()):
    print(f"  {key[0]} / {key[1]}: {count}")
(MODEL_DIR / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
print(f"\nExported Phase 3 forests to {MODEL_DIR}")
