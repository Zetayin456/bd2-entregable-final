"""Analiza observaciones reales exportadas por run_experiment.ps1.

Entrada CSV requerida: run_id,condition,throughput_rps. Una fila equivale a una
corrida independiente; no se generan muestras sintéticas ni se mezclan capas.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy import stats


def holm(p_values: list[float]) -> list[float]:
    order = np.argsort(p_values)
    adjusted = [1.0] * len(p_values)
    running = 0.0
    for rank, index in enumerate(order):
        running = max(running, (len(order) - rank) * p_values[index])
        adjusted[index] = min(1.0, float(running))
    return adjusted


def cliffs_delta(left: np.ndarray, right: np.ndarray) -> float:
    ordered = np.sort(right)
    more = np.searchsorted(ordered, left, side="left").sum()
    less = (len(right) - np.searchsorted(ordered, left, side="right")).sum()
    return float((more - less) / (len(left) * len(right)))


def bootstrap_median_difference(left: np.ndarray, right: np.ndarray) -> list[float]:
    rng = np.random.default_rng(20261122)
    differences = np.empty(10_000)
    for index in range(len(differences)):
        a = rng.choice(left, size=len(left), replace=True)
        b = rng.choice(right, size=len(right), replace=True)
        differences[index] = np.median(a) - np.median(b)
    return [float(value) for value in np.quantile(differences, [.025, .975])]


def read_observations(path: Path) -> dict[str, list[float]]:
    groups: dict[str, list[float]] = defaultdict(list)
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {"run_id", "condition", "throughput_rps"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise ValueError("El CSV requiere las columnas run_id,condition,throughput_rps.")
        seen: set[tuple[str, str]] = set()
        for row in reader:
            key = (row["condition"].strip(), row["run_id"].strip())
            if not all(key):
                raise ValueError("Cada observación debe tener condition y run_id.")
            if key in seen:
                raise ValueError(f"Corrida duplicada: {key[1]} ({key[0]}).")
            seen.add(key)
            value = float(row["throughput_rps"])
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"Throughput inválido en corrida {key[1]}.")
            groups[key[0]].append(value)
    if len(groups) < 2:
        raise ValueError("Se requieren al menos dos condiciones experimentales.")
    if any(len(values) < 3 for values in groups.values()):
        raise ValueError("Se requieren al menos tres corridas independientes por condición.")
    return dict(groups)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, default=Path("results/observations.csv"))
    parser.add_argument("--output", type=Path, default=Path("results/analysis.json"))
    args = parser.parse_args()
    try:
        groups = read_observations(args.input)
    except (OSError, ValueError, KeyError) as error:
        parser.error(str(error))

    normality = {}
    for name, values in groups.items():
        test = stats.shapiro(values)
        normality[name] = {"W": float(test.statistic), "p_value": float(test.pvalue), "normal_at_0_05": bool(test.pvalue >= .05)}
    all_normal = all(item["normal_at_0_05"] for item in normality.values())
    arrays = [np.asarray(values, dtype=float) for values in groups.values()]
    omnibus = stats.f_oneway(*arrays) if all_normal else stats.kruskal(*arrays)
    pairwise = []
    names = list(groups)
    for index, left_name in enumerate(names):
        for right_name in names[index + 1:]:
            left, right = np.asarray(groups[left_name]), np.asarray(groups[right_name])
            test = stats.ttest_ind(left, right, equal_var=False) if all_normal else stats.mannwhitneyu(left, right, alternative="two-sided")
            pairwise.append({"left": left_name, "right": right_name, "test": "Welch t" if all_normal else "Mann–Whitney U", "statistic": float(test.statistic), "p_raw": float(test.pvalue), "cliffs_delta": cliffs_delta(left, right), "median_difference_ci_95_bootstrap": bootstrap_median_difference(left, right)})
    adjusted = holm([row["p_raw"] for row in pairwise])
    for row, p_adj in zip(pairwise, adjusted):
        row["p_holm"] = p_adj
        row["reject_equal_at_0_05"] = bool(p_adj < .05)
    result = {
        "input": str(args.input),
        "n_by_condition": {name: len(values) for name, values in groups.items()},
        "descriptive": {name: {"mean_rps": float(np.mean(values)), "median_rps": float(np.median(values)), "sd_rps": float(np.std(values, ddof=1)), "min_rps": float(np.min(values)), "max_rps": float(np.max(values))} for name, values in groups.items()},
        "normality_shapiro": normality,
        "omnibus": {"test": "one-way ANOVA" if all_normal else "Kruskal–Wallis", "statistic": float(omnibus.statistic), "p_value": float(omnibus.pvalue)},
        "post_hoc": pairwise,
        "alpha": .05,
        "interpretation": "Rechazar H0 solo para comparaciones con p de Holm < 0.05; interpretar el tamaño del efecto y el diseño junto con el valor p.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
