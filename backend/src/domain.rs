//! Reglas puras del dominio, aisladas de HTTP y CouchDB.
use serde_json::Value;

pub(crate) fn movement_id(pesaje_id: &str) -> String {
    format!("movimiento_puntos:pesaje:{pesaje_id}")
}

pub(crate) fn calculate_points_with_rules(
    pesaje: &Value,
    rules: &Value,
) -> Result<(i64, Value), ()> {
    let rates = rules
        .get("puntos_por_kg")
        .and_then(Value::as_object)
        .ok_or(())?;
    let lines = pesaje
        .get("lineas")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
        .ok_or(())?;
    if lines.len() > 10 {
        return Err(());
    }
    let mut total = 0.0_f64;
    for line in lines {
        let material = line
            .get("material")
            .and_then(Value::as_str)
            .map(|v| v.trim().to_lowercase())
            .filter(|v| !v.is_empty())
            .ok_or(())?;
        let weight = line
            .get("peso_kg")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v > 0.0 && *v <= 1_000.0)
            .ok_or(())?;
        let rate = rates
            .get(&material)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v > 0.0 && *v <= 1_000_000.0)
            .ok_or(())?;
        total += weight * rate;
    }
    if !total.is_finite() || total > 2_000.0 || total > i64::MAX as f64 {
        return Err(());
    }
    let points = total.round() as i64;
    if points <= 0 {
        return Err(());
    }
    Ok((points, rules.clone()))
}
