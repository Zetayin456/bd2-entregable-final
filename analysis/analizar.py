"""Analiza observaciones reales exportadas por run_experiment.ps1.

Entrada CSV requerida: run_id,condition,throughput_rps,
business_flow_success_rate,http_failure_rate. Una fila equivale a una corrida
independiente. La comparación de throughput usa solo corridas con el flujo completo
y cero fallos HTTP; la fiabilidad de todas las corridas se reporta por separado.
Se requieren tres corridas válidas en al menos dos condiciones.
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


def read_observations(path: Path) -> tuple[
    dict[str, list[float]], dict[str, int], dict[str, dict[str, float | int]]
]:
    groups: dict[str, list[float]] = defaultdict(list)
    flow_success: dict[str, list[float]] = defaultdict(list)
    http_failure: dict[str, list[float]] = defaultdict(list)
    failed_runs: dict[str, int] = defaultdict(int)
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {
            "run_id", "condition", "throughput_rps",
            "business_flow_success_rate", "http_failure_rate",
        }
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise ValueError(
                "El CSV requiere run_id,condition,throughput_rps,"
                "business_flow_success_rate,http_failure_rate."
            )
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
            success = float(row["business_flow_success_rate"])
            failure = float(row["http_failure_rate"])
            if not math.isfinite(success) or not 0 <= success <= 1:
                raise ValueError(f"business_flow_success_rate inválida en corrida {key[1]}.")
            if not math.isfinite(failure) or not 0 <= failure <= 1:
                raise ValueError(f"http_failure_rate inválida en corrida {key[1]}.")
            flow_success[key[0]].append(success)
            http_failure[key[0]].append(failure)
            if math.isclose(success, 1.0, abs_tol=1e-12) and math.isclose(failure, 0.0, abs_tol=1e-12):
                groups[key[0]].append(value)
            else:
                failed_runs[key[0]] += 1
    reliability = {
        name: {
            "runs_total": len(flow_success[name]),
            "runs_error_free": len(groups.get(name, [])),
            "runs_excluded_from_throughput_test": failed_runs.get(name, 0),
            "mean_business_flow_success_rate": float(np.mean(flow_success[name])),
            "mean_http_failure_rate": float(np.mean(http_failure[name])),
        }
        for name in flow_success
    }
    excluded = {name: len(values) for name, values in groups.items() if len(values) < 3}
    replicated = {name: values for name, values in groups.items() if len(values) >= 3}
    if len(replicated) < 2:
        raise ValueError(
            "Se requieren al menos dos condiciones con tres o más corridas independientes; "
            f"condiciones válidas: {len(replicated)}."
        )
    return replicated, excluded, reliability


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, default=Path("results/observations.csv"))
    parser.add_argument("--output", type=Path, default=Path("results/analysis.json"))
    args = parser.parse_args()
    try:
        groups, excluded, reliability = read_observations(args.input)
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
        "analysis_scope": "Comparación estadística entre condiciones de carga del API Rust con CouchDB; no incluye observaciones pgbench.",
        "baseline_scope": "PostgreSQL/pgbench mide operaciones SQL de persistencia (upsert y lectura indexada) sobre baseline_documents; no es una API alternativa ni incluye autenticación, autorización, reglas de negocio, orquestación Rust o cliente HTTP.",
        "cross_system_comparison": "No realizada: las filas pgbench y las métricas k6 del API corresponden a capas y cargas distintas, por lo que no se mezclan ni se interpretan como comparación integral equivalente.",
        "n_by_condition": {name: len(values) for name, values in groups.items()},
        "excluded_under_replicated_conditions": excluded,
        "reliability_by_condition_all_runs": reliability,
        "throughput_inference_sample": "Solo corridas con 100% de flujos de negocio exitosos y 0% de fallos HTTP.",
        "descriptive": {name: {"mean_rps": float(np.mean(values)), "median_rps": float(np.median(values)), "sd_rps": float(np.std(values, ddof=1)), "min_rps": float(np.min(values)), "max_rps": float(np.max(values))} for name, values in groups.items()},
        "normality_shapiro": normality,
        "omnibus": {"test": "one-way ANOVA" if all_normal else "Kruskal–Wallis", "statistic": float(omnibus.statistic), "p_value": float(omnibus.pvalue)},
        "post_hoc": pairwise,
        "alpha": .05,
        "interpretation": "Las pruebas inferenciales comparan únicamente throughput k6 entre condiciones del API Rust+CouchDB con flujos válidos. PostgreSQL/pgbench es una referencia separada de persistencia SQL, no una comparación de API completa. Rechazar H0 solo para comparaciones con p de Holm < 0.05 e interpretar tamaño del efecto y diseño junto con el valor p.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for name, count in excluded.items():
        print(f"Omitida {name}: solo {count} corrida(s) válidas; se requieren al menos 3.")
    for name, metrics in reliability.items():
        excluded_count = metrics["runs_excluded_from_throughput_test"]
        if excluded_count:
            print(f"{name}: {excluded_count} corrida(s) con fallos se excluyen del contraste de throughput y quedan en el resumen de fiabilidad.")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
