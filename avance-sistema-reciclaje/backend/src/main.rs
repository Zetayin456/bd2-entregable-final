
use axum::{
    extract::{Path, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};

use jsonwebtoken::{
    decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation,
};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::time::{SystemTime, UNIX_EPOCH};
use tower_http::cors::CorsLayer;

// ========================
// ESTRUCTURAS
// ========================

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    role: String,
    exp: usize,
}

#[derive(Deserialize)]
struct LoginRequest {
    usuario: String,
    contrasena: String,
}

#[derive(Clone)]
struct AppState {
    client: Client,
    couch_url: String,
    user: String,
    password: String,
    database: String,
    jwt_secret: String,
    admin_user: String,
    admin_password: String,
    recolector_user: String,
    recolector_password: String,
}

// ========================
// SALUD DE LA API
// ========================

async fn salud() -> impl IntoResponse {
    Json(json!({
        "estado": "activo",
        "mensaje": "API del Sistema de Reciclaje funcionando"
    }))
}

// ========================
// FUNCIONES AUXILIARES
// ========================

async fn obtener_documento(
    state: &AppState,
    id: &str,
) -> Result<(StatusCode, String), (StatusCode, String)> {
    let url = format!("{}/{}/{}", state.couch_url, state.database, id);

    let response = state.client
        .get(url)
        .basic_auth(&state.user, Some(&state.password))
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();

    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok((status, body))
}


 // ========================
 // SINCRONIZACION OFFLINE
 // ========================

async fn sincronizar_documento(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(mut documento): Json<Value>,
)-> Result<Json<Value>, (StatusCode, String)> {

    if !id.starts_with("cola_")
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Identificador de sincronizacion invalido".to_string(),
        ));
    }

    if !documento.is_object() {
        return Err((
            StatusCode::BAD_REQUEST,
            "El documento debe ser un objeto JSON".to_string(),
        ));
    }

    let tipo = documento.get("type_registro")
    .and_then(Value::as_str)
    .map(str::to_owned)
    .ok_or((
        StatusCode::BAD_REQUEST,
        "Falta el tipo de registro".to_string(),
    ))?;
    

    let tipo_documento = match tipo.as_str() {
        "comercio" => "comercio",
        "solicitud" => "solicitud",
        "pesaje" => "pesaje",
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "Tipo de registro no permitido".to_string(),
            ));
        }
    };

   match tipo.as_str() {
        "solicitud" => {
            for campo in ["comercio_id", "tipo_residuo", "direccion"] {
                if documento.get(campo)
                    .and_then(Value::as_str)
                    .map(|v| v.trim().is_empty())
                    .unwrap_or(true)
                {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        format!("El campo {} es obligatorio", campo),
                    ));
                }
            }

            let cantidad = documento.get("cantidad_aproximada")
                .and_then(Value::as_f64);

            if cantidad.map(|v| !v.is_finite() || v <= 0.0).unwrap_or(true) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "La cantidad debe ser mayor que cero".to_string(),
                ));
            }
        }

        "pesaje" => {
           for campo in ["solicitud_id", "comercio_id", "tipo_residuo"] {
                if documento.get(campo)
                    .and_then(Value::as_str)
                    .map(|v| v.trim().is_empty())
                    .unwrap_or(true)
                {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        format!("El campo {} es obligatorio", campo),
                    ));
                }
            }

            let peso = documento.get("peso_kg").and_then(Value::as_f64);

            if peso.map(|v| !v.is_finite() || v <= 0.0).unwrap_or(true) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "El peso debe ser mayor que cero".to_string(),
                ));
            }
        }

        _ => {}
    }
        if tipo_documento == "pesaje" {
        let claims = validar_token(
            &headers,
            &state.jwt_secret,
            &["recolector"],
        )?;

        documento["recolector_id"] = json!(claims.sub);
    }

    documento["_id"] = json!(id);
    documento["sync_id"] = json!(id);
    documento["type"] = json!(tipo_documento);

    if tipo == "solicitud" {
        documento["estado"] = json!("pendiente");
    } else if tipo == "pesaje" {
        documento["estado"] = json!("pendiente_verificacion");
    }

    let url = format!("{}/{}/{}", state.couch_url, state.database, id);

    let response = state.client
        .put(&url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&documento)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();
    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if status.is_success() {
        let data: Value = serde_json::from_str(&body)
            .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

        return Ok(Json(data));
    }

    if status == StatusCode::CONFLICT {
        let (existing_status, existing_body) =
            obtener_documento(&state, &id).await?;

        if existing_status.is_success() {
            let existing: Value = serde_json::from_str(&existing_body)
                .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

            if existing.get("sync_id").and_then(Value::as_str) == Some(id.as_str())
                && existing.get("type").and_then(Value::as_str) == Some(tipo_documento)
            {
                return Ok(Json(json!({
                    "ok": true,
                    "id": id,
                    "duplicado": true,
                    "mensaje": "El documento ya estaba sincronizado"
                })));
            }
        }

        return Err((
            StatusCode::CONFLICT,
            "El identificador ya existe con otro documento".to_string(),
        ));
    }

    Err((StatusCode::BAD_GATEWAY, body))
}


// ========================
// MODULO COMERCIOS
// ========================

async fn listar_comercios(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let url = format!(
        "{}/{}/_all_docs?include_docs=true",
        state.couch_url, state.database
    );

    let response = state.client
        .get(url)
        .basic_auth(&state.user, Some(&state.password))
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();

    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(data))
}

async fn crear_comercio(
    State(state): State<AppState>,
    Json(mut comercio): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if !comercio.is_object() {
        return Err((
            StatusCode::BAD_REQUEST,
            "El comercio debe ser un objeto JSON".to_string(),
        ));
    }

    comercio["type"] = json!("comercio");

    let url = format!("{}/{}", state.couch_url, state.database);

    let response = state.client
        .post(url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&comercio)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();

    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(data))
}

async fn obtener_comercio(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (status, body) = obtener_documento(&state, &id).await?;

    if status == StatusCode::NOT_FOUND {
        return Err((
            StatusCode::NOT_FOUND,
            "Comercio no encontrado".to_string(),
        ));
    }

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if data.get("type").and_then(Value::as_str) != Some("comercio") {
        return Err((
            StatusCode::NOT_FOUND,
            "Comercio no encontrado".to_string(),
        ));
    }

    Ok(Json(data))
}

async fn actualizar_comercio(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut comercio): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if !comercio.is_object() {
        return Err((
            StatusCode::BAD_REQUEST,
            "El comercio debe ser un objeto JSON".to_string(),
        ));
    }

    if comercio.get("_rev").and_then(Value::as_str).is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Se necesita la revision _rev actual del comercio".to_string(),
        ));
    }

    comercio["_id"] = json!(id);
    comercio["type"] = json!("comercio");

    let url = format!("{}/{}/{}", state.couch_url, state.database, id);

    let response = state.client
        .put(url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&comercio)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();

    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(data))
}

// ========================
// MODULO SOLICITUDES
// ========================

async fn crear_solicitud(
    State(state): State<AppState>,
    Json(mut solicitud): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if !solicitud.is_object() {
        return Err((
            StatusCode::BAD_REQUEST,
            "La solicitud debe ser un objeto JSON".to_string(),
        ));
    }

    for campo in ["comercio_id", "tipo_residuo", "direccion"] {
        if solicitud.get(campo)
            .and_then(Value::as_str)
            .map(|v| v.trim().is_empty())
            .unwrap_or(true)
        {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("El campo {} es obligatorio y debe ser texto", campo),
            ));
        }
    }

    let cantidad = solicitud
        .get("cantidad_aproximada")
        .and_then(Value::as_f64);

    if cantidad.map(|v| !v.is_finite() || v <= 0.0).unwrap_or(true) {
        return Err((
            StatusCode::BAD_REQUEST,
            "La cantidad aproximada debe ser un numero mayor que cero".to_string(),
        ));
    }

    solicitud["type"] = json!("solicitud");
    solicitud["estado"] = json!("pendiente");

    let url = format!("{}/{}", state.couch_url, state.database);

    let response = state.client
        .post(url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&solicitud)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();

    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(data))
}

async fn listar_solicitudes(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let url = format!("{}/{}/_find", state.couch_url, state.database);

    let filtro = json!({
        "selector": {
            "type": "solicitud"
        }
    });

    let response = state.client
        .post(url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&filtro)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();

    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(data))
}

async fn obtener_solicitud(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (status, body) = obtener_documento(&state, &id).await?;

    if status == StatusCode::NOT_FOUND {
        return Err((
            StatusCode::NOT_FOUND,
            "Solicitud no encontrada".to_string(),
        ));
    }

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if data.get("type").and_then(Value::as_str) != Some("solicitud") {
        return Err((
            StatusCode::NOT_FOUND,
            "Solicitud no encontrada".to_string(),
        ));
    }

    Ok(Json(data))
}

// ========================
// MODULO PESAJES
// ========================

async fn crear_pesaje(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut pesaje): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {

    let claims = validar_token(
        &headers,
        &state.jwt_secret,
        &["recolector"],
    )?;

    pesaje["recolector_id"] = json!(claims.sub);

    for campo in ["solicitud_id", "comercio_id", "tipo_residuo"] {
        if pesaje.get(campo)
            .and_then(Value::as_str)
            .map(|v| v.trim().is_empty())
            .unwrap_or(true)
        {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("El campo {} es obligatorio y debe ser texto", campo),
            ));
        }
    }

    let peso = pesaje.get("peso_kg").and_then(Value::as_f64);

    if peso.map(|v| !v.is_finite() || v <= 0.0).unwrap_or(true) {
        return Err((
            StatusCode::BAD_REQUEST,
            "El peso debe ser un numero mayor que cero".to_string(),
        ));
    }

    pesaje["type"] = json!("pesaje");
    pesaje["estado"] = json!("pendiente_verificacion");

    let url = format!("{}/{}", state.couch_url, state.database);

    let response = state.client
        .post(url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&pesaje)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();

    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(data))
}

async fn listar_pesajes(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let url = format!("{}/{}/_find", state.couch_url, state.database);

    let filtro = json!({
        "selector": {
            "type": "pesaje"
        }
    });

    let response = state.client
        .post(url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&filtro)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();

    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(data))
}

async fn obtener_pesaje(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (status, body) = obtener_documento(&state, &id).await?;

    if status == StatusCode::NOT_FOUND {
        return Err((
            StatusCode::NOT_FOUND,
            "Pesaje no encontrado".to_string(),
        ));
    }

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if data.get("type").and_then(Value::as_str) != Some("pesaje") {
        return Err((
            StatusCode::NOT_FOUND,
            "Pesaje no encontrado".to_string(),
        ));
    }

    Ok(Json(data))
}

// ========================
// VERIFICAR UN PESAJE
// ========================

async fn verificar_pesaje(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    validar_token(
        &headers,
        &state.jwt_secret,
        &["admin_plataforma"],
    )?;

    let (status, body) = obtener_documento(&state, &id).await?;

    if status == StatusCode::NOT_FOUND {
        return Err((
            StatusCode::NOT_FOUND,
            "Pesaje no encontrado".to_string(),
        ));
    }

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let mut pesaje: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if pesaje.get("type").and_then(Value::as_str) != Some("pesaje") {
        return Err((
            StatusCode::NOT_FOUND,
            "Pesaje no encontrado".to_string(),
        ));
    }

    if pesaje.get("estado").and_then(Value::as_str) == Some("verificado") {
        return Ok(Json(json!({
            "ok": true,
            "mensaje": "El pesaje ya estaba verificado",
            "pesaje": pesaje
        })));
    }

    pesaje["estado"] = json!("verificado");

    let url = format!("{}/{}/{}", state.couch_url, state.database, id);

    let response = state.client
        .put(url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&pesaje)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let update_status = response.status();

    let update_body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !update_status.is_success() {
        return Err((StatusCode::CONFLICT, update_body));
    }

    let data: Value = serde_json::from_str(&update_body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(data))
}

// ========================
// MODULO PUNTOS
// ========================

async fn crear_movimiento_puntos(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(datos): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    validar_token(
        &headers,
        &state.jwt_secret,
        &["admin_plataforma"],
    )?;

    let pesaje_id = datos.get("pesaje_id")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or((
            StatusCode::BAD_REQUEST,
            "El campo pesaje_id es obligatorio".to_string(),
        ))?;

    let puntos = datos.get("puntos")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)
        .ok_or((
            StatusCode::BAD_REQUEST,
            "Los puntos deben ser un numero entero mayor que cero".to_string(),
        ))?;

    let (status, body) = obtener_documento(&state, pesaje_id).await?;

    if status == StatusCode::NOT_FOUND {
        return Err((
            StatusCode::NOT_FOUND,
            "Pesaje no encontrado".to_string(),
        ));
    }

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let pesaje: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if pesaje.get("type").and_then(Value::as_str) != Some("pesaje") {
        return Err((
            StatusCode::NOT_FOUND,
            "Pesaje no encontrado".to_string(),
        ));
    }

    if pesaje.get("estado").and_then(Value::as_str) != Some("verificado") {
        return Err((
            StatusCode::CONFLICT,
            "No se pueden asignar puntos: el pesaje aun no esta verificado".to_string(),
        ));
    }

    let comercio_id = pesaje.get("comercio_id")
        .and_then(Value::as_str)
        .ok_or((
            StatusCode::BAD_REQUEST,
            "El pesaje no tiene comercio_id".to_string(),
        ))?;

    let movimiento_id = format!("movimiento_puntos_{}", pesaje_id);

    let movimiento = json!({
        "_id": movimiento_id,
        "type": "movimiento_puntos",
        "comercio_id": comercio_id,
        "pesaje_id": pesaje_id,
        "puntos": puntos,
        "operacion": "credito"
    });

    let url = format!(
        "{}/{}/{}",
        state.couch_url,
        state.database,
        movimiento_id
    );

    let response = state.client
        .put(url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&movimiento)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let create_status = response.status();

    let create_body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if create_status == StatusCode::CONFLICT {
        return Err((
            StatusCode::CONFLICT,
            "Este pesaje ya genero un movimiento de puntos; no se duplicara".to_string(),
        ));
    }

    if !create_status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, create_body));
    }

    let data: Value = serde_json::from_str(&create_body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(data))
}

// ========================
// LISTAR MOVIMIENTOS DE PUNTOS
// ========================

async fn listar_movimientos_puntos(
    State(state): State<AppState>,
    Path(comercio_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let url = format!("{}/{}/_find", state.couch_url, state.database);

    let filtro = json!({
        "selector": {
            "type": "movimiento_puntos",
            "comercio_id": comercio_id
        }
    });

    let response = state.client
        .post(url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&filtro)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();

    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    Ok(Json(data))
}

// ========================
// CONSULTAR SALDO
// ========================

async fn consultar_saldo(
    State(state): State<AppState>,
    Path(comercio_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let url = format!("{}/{}/_find", state.couch_url, state.database);

    let filtro = json!({
        "selector": {
            "type": "movimiento_puntos",
            "comercio_id": comercio_id
        }
    });

    let response = state.client
        .post(url)
        .basic_auth(&state.user, Some(&state.password))
        .json(&filtro)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let status = response.status();

    let body = response.text().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !status.is_success() {
        return Err((StatusCode::BAD_GATEWAY, body));
    }

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let docs = data.get("docs")
        .and_then(Value::as_array)
        .ok_or((
            StatusCode::BAD_GATEWAY,
            "Respuesta inesperada de CouchDB".to_string(),
        ))?;

    let mut saldo: i64 = 0;

    for doc in docs {
        let puntos = doc.get("puntos")
            .and_then(Value::as_i64)
            .unwrap_or(0);

        match doc.get("operacion").and_then(Value::as_str) {
            Some("credito") => saldo += puntos,
            Some("debito") => saldo -= puntos,
            _ => {}
        }
    }

    Ok(Json(json!({
        "comercio_id": comercio_id,
        "saldo_puntos": saldo,
        "cantidad_movimientos": docs.len()
    })))
}

// ========================
// AUTENTICACION JWT
// ========================

async fn login(
    State(state): State<AppState>,
    Json(credentials): Json<LoginRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {

    let rol = if credentials.usuario == state.admin_user
        && credentials.contrasena == state.admin_password
    {
        "admin_plataforma"
    } else if credentials.usuario == state.recolector_user
        && credentials.contrasena == state.recolector_password
    {
        "recolector"
    } else {
        return Err((
            StatusCode::UNAUTHORIZED,
            "Credenciales incorrectas".to_string(),
        ));
    };

    let expiracion = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as usize
        + 60 * 60 * 8;

    let claims = Claims {
        sub: credentials.usuario,
        role: rol.to_string(),
        exp: expiracion,
    };

    let clave = EncodingKey::from_secret(state.jwt_secret.as_bytes())
        .map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            "No se pudo crear la clave JWT".to_string(),
        ))?;

    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &clave,
    )
    .map_err(|_| (
        StatusCode::INTERNAL_SERVER_ERROR,
        "No se pudo generar el token".to_string(),
    ))?;

    Ok(Json(json!({
        "access_token": token,
        "token_type": "Bearer",
        "expires_in": 28800,
        "rol": rol
    })))
}
    

fn validar_token(
    headers: &HeaderMap,
    secret: &str,
    roles_permitidos: &[&str],
) -> Result<Claims, (StatusCode, String)> {
    let authorization = headers
        .get(AUTHORIZATION)
        .and_then(|valor| valor.to_str().ok())
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "Falta el token de autenticacion".to_string(),
        ))?;

    let token = authorization
        .strip_prefix("Bearer ")
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "Formato de token incorrecto".to_string(),
        ))?;

    let clave = DecodingKey::from_secret(secret.as_bytes())
        .map_err(|_| (
            StatusCode::INTERNAL_SERVER_ERROR,
            "No se pudo crear la clave de validacion JWT".to_string(),
        ))?;

    let token_data = decode::<Claims>(
        token,
        &clave,
        &Validation::new(Algorithm::HS256),
    )
    .map_err(|_| (
        StatusCode::UNAUTHORIZED,
        "Token invalido o expirado".to_string(),
    ))?;

    if !roles_permitidos.contains(&token_data.claims.role.as_str()) {
        return Err((
            StatusCode::FORBIDDEN,
            "No tienes permisos para realizar esta operacion".to_string(),
        ));
    }

    Ok(token_data.claims)
}

// ========================
// INICIO DEL SERVIDOR
// ========================

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let state = AppState {
        client: Client::new(),

        couch_url: env::var("COUCHDB_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:5984".to_string()),

        user: env::var("COUCHDB_USER")
            .expect("Falta COUCHDB_USER en .env"),

        password: env::var("COUCHDB_PASSWORD")
            .expect("Falta COUCHDB_PASSWORD en .env"),

        database: env::var("COUCHDB_DATABASE")
            .unwrap_or_else(|_| "sistema_reciclaje".to_string()),

        jwt_secret: env::var("JWT_SECRET")
            .expect("Falta JWT_SECRET en .env"),

        admin_user: env::var("AUTH_ADMIN_USER")
            .expect("Falta AUTH_ADMIN_USER en .env"),

        admin_password: env::var("AUTH_ADMIN_PASSWORD")
            .expect("Falta AUTH_ADMIN_PASSWORD en .env"),
            recolector_user: env::var("AUTH_RECOLECTOR_USER")
    .expect("Falta AUTH_RECOLECTOR_USER en .env"),

recolector_password: env::var("AUTH_RECOLECTOR_PASSWORD")
    .expect("Falta AUTH_RECOLECTOR_PASSWORD en .env"),
    };

    let app = Router::new()
        .route("/auth/login", post(login))
        .route("/salud", get(salud))
        .route("/sincronizar/{id}", put(sincronizar_documento))
        .route(
            "/comercios",
            get(listar_comercios).post(crear_comercio),
        )
        .route(
            "/comercios/{id}",
            get(obtener_comercio).put(actualizar_comercio),
        )
        .route(
            "/solicitudes",
            get(listar_solicitudes).post(crear_solicitud),
        )
        .route(
            "/solicitudes/{id}",
            get(obtener_solicitud),
        )
        .route(
            "/pesajes",
            get(listar_pesajes).post(crear_pesaje),
        )
        .route(
            "/pesajes/{id}",
            get(obtener_pesaje),
        )
        .route(
            "/pesajes/{id}/verificar",
            post(verificar_pesaje),
        )
        .route(
            "/puntos",
            post(crear_movimiento_puntos),
        )
        .route(
            "/comercios/{id}/puntos/movimientos",
            get(listar_movimientos_puntos),
        )
        .route(
            "/comercios/{id}/saldo",
            get(consultar_saldo),
        )
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port = env::var("API_PORT")
        .unwrap_or_else(|_| "3000".to_string());

    let address = format!("127.0.0.1:{}", port);

    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .expect("No se pudo iniciar el servidor");

    println!("Servidor iniciado en http://{}", address);

    axum::serve(listener, app)
        .await
        .expect("Error en el servidor");
}

