use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::{env, sync::Arc};

#[derive(Clone)]
struct App {
    http: Client,
    couch: String,
    db: String,
    db_user: String,
    db_password: String,
    secret: String,
    proxy_secret: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Claims {
    sub: String,
    role: String,
    #[serde(default)]
    comercio_id: Option<String>,
    exp: usize,
}
#[derive(Deserialize)]
struct Login {
    username: String,
    password: String,
}
#[derive(Deserialize)]
struct NewUser {
    username: String,
    password: String,
    role: String,
    comercio_id: Option<String>,
}
#[derive(Deserialize)]
struct DocInput {
    #[serde(flatten)]
    body: Value,
}
fn err(code: StatusCode) -> Response {
    (code, Json(json!({"error": if code == StatusCode::UNAUTHORIZED {"no_autorizado"} else if code == StatusCode::FORBIDDEN {"prohibido"} else if code == StatusCode::NOT_FOUND {"no_encontrado"} else {"solicitud_invalida"}}))).into_response()
}
fn valid_role(role: &str) -> bool {
    matches!(
        role,
        "admin_plataforma" | "operador_acopio" | "recolector" | "comercio"
    )
}
async fn login(State(a): State<Arc<App>>, Json(input): Json<Login>) -> Response {
    if input.username.len() > 80 || input.password.len() > 256 {
        return err(StatusCode::BAD_REQUEST);
    }
    let session = a
        .http
        .get(format!("{}/_session", a.couch))
        .basic_auth(&input.username, Some(&input.password))
        .send()
        .await;
    let Ok(session) = session else {
        return err(StatusCode::SERVICE_UNAVAILABLE);
    };
    if !session.status().is_success() {
        return err(StatusCode::UNAUTHORIZED);
    }
    let Ok(sess) = session.json::<Value>().await else {
        return err(StatusCode::UNAUTHORIZED);
    };
    if sess.pointer("/userCtx/name").and_then(Value::as_str) != Some(&input.username) {
        return err(StatusCode::UNAUTHORIZED);
    }
    let userdoc = a
        .http
        .get(format!(
            "{}/_users/org.couchdb.user:{}",
            a.couch,
            urlencoding::encode(&input.username)
        ))
        .basic_auth(&a.db_user, Some(&a.db_password))
        .send()
        .await;
    let Ok(userdoc) = userdoc else {
        return err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Ok(v) = userdoc.json::<Value>().await else {
        return err(StatusCode::UNAUTHORIZED);
    };
    let Some(role) = v
        .get("roles")
        .and_then(Value::as_array)
        .and_then(|rs| rs.iter().filter_map(Value::as_str).find(|r| valid_role(r)))
    else {
        return err(StatusCode::UNAUTHORIZED);
    };
    if !valid_role(role) {
        return err(StatusCode::UNAUTHORIZED);
    }
    let comercio_id = v
        .get("comercio_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let claims = Claims {
        sub: input.username,
        role: role.to_owned(),
        comercio_id,
        exp: (Utc::now() + Duration::hours(8)).timestamp() as usize,
    };
    match encode(&Header::default(),&claims,&EncodingKey::from_secret(a.secret.as_bytes())) {Ok(token)=>(StatusCode::OK,Json(json!({"token":token,"username":claims.sub,"role":claims.role,"comercio_id":claims.comercio_id,"expires_in":28800}))).into_response(),Err(_)=>err(StatusCode::INTERNAL_SERVER_ERROR)}
}
async fn auth(
    State(a): State<Arc<App>>,
    mut req: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(token) = token else {
        return err(StatusCode::UNAUTHORIZED);
    };
    let Ok(data) = decode::<Claims>(
        token,
        &DecodingKey::from_secret(a.secret.as_bytes()),
        &Validation::default(),
    ) else {
        return err(StatusCode::UNAUTHORIZED);
    };
    req.extensions_mut().insert(data.claims);
    next.run(req).await
}
fn can_read(c: &Claims, d: &Value) -> bool {
    match c.role.as_str() {
        "admin_plataforma" | "operador_acopio" => true,
        "recolector" => d.get("recolector_id").and_then(Value::as_str) == Some(&c.sub),
        "comercio" => c.comercio_id.as_deref().is_some_and(|id| {
            d.get("comercio_id").and_then(Value::as_str) == Some(id)
                || d.get("_id").and_then(Value::as_str) == Some(id)
        }),
        _ => false,
    }
}
fn can_write(c: &Claims, d: &Value) -> bool {
    let typ = d.get("type").and_then(Value::as_str).unwrap_or("");
    match c.role.as_str() {
        "admin_plataforma" => true,
        "operador_acopio" => {
            typ == "comercio"
                || typ == "pesaje" && d.get("estado").and_then(Value::as_str) == Some("verificado")
                || typ == "solicitud_recoleccion"
        }
        "recolector" => {
            typ == "pesaje"
                && d.get("recolector_id").and_then(Value::as_str) == Some(&c.sub)
                && d.get("estado").and_then(Value::as_str) != Some("verificado")
        }
        "comercio" => {
            typ == "solicitud_recoleccion"
                && c.comercio_id
                    .as_deref()
                    .is_some_and(|id| d.get("comercio_id").and_then(Value::as_str) == Some(id))
        }
        _ => false,
    }
}
fn movement_id(pesaje_id: &str) -> String {
    format!("movimiento_puntos:pesaje:{pesaje_id}")
}
async fn couch_get(a: &App, id: &str) -> Result<reqwest::Response, ()> {
    a.http
        .get(format!("{}/{}/{}", a.couch, a.db, urlencoding::encode(id)))
        .basic_auth(&a.db_user, Some(&a.db_password))
        .send()
        .await
        .map_err(|_| ())
}
async fn calculate_points(a: &App, pesaje: &Value) -> Result<(i64, Value), ()> {
    let rules_response = couch_get(a, "config:puntos").await?;
    if !rules_response.status().is_success() {
        return Err(());
    }
    let rules = rules_response.json::<Value>().await.map_err(|_| ())?;
    calculate_points_with_rules(pesaje, &rules)
}
fn calculate_points_with_rules(pesaje: &Value, rules: &Value) -> Result<(i64, Value), ()> {
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
async fn ensure_points_for_pesaje(a: &App, pesaje: &Value) -> Result<Value, ()> {
    let pesaje_id = pesaje.get("_id").and_then(Value::as_str).ok_or(())?;
    let comercio_id = pesaje
        .get("comercio_id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or(())?;
    let movement_id = movement_id(pesaje_id);
    let existing = couch_get(a, &movement_id).await?;
    if existing.status().is_success() {
        let doc = existing.json::<Value>().await.map_err(|_| ())?;
        if doc.get("type").and_then(Value::as_str) == Some("movimiento_puntos")
            && doc.get("pesaje_id").and_then(Value::as_str) == Some(pesaje_id)
            && doc.get("comercio_id").and_then(Value::as_str) == Some(comercio_id)
        {
            return Ok(doc);
        }
        return Err(());
    }
    if existing.status().as_u16() != StatusCode::NOT_FOUND.as_u16() {
        return Err(());
    }
    let (points, rules) = calculate_points(a, pesaje).await?;
    let created_at = pesaje
        .get("verificado_en")
        .and_then(Value::as_str)
        .or_else(|| pesaje.get("capturado_en").and_then(Value::as_str))
        .unwrap_or_else(|| "fecha_no_disponible");
    let movement = json!({"_id":movement_id,"type":"movimiento_puntos","comercio_id":comercio_id,"concepto":"acreditacion","puntos":points,"origen":"pesaje_verificado","pesaje_id":pesaje_id,"regla_version":rules.get("version").cloned().unwrap_or(json!(1)),"creado_en":created_at});
    let write = a
        .http
        .put(format!(
            "{}/{}/{}",
            a.couch,
            a.db,
            urlencoding::encode(&movement_id)
        ))
        .basic_auth(&a.db_user, Some(&a.db_password))
        .json(&movement)
        .send()
        .await
        .map_err(|_| ())?;
    if write.status().is_success() {
        return write
            .json::<Value>()
            .await
            .map(|_| movement)
            .map_err(|_| ());
    }
    if write.status().as_u16() == StatusCode::CONFLICT.as_u16() {
        let existing = couch_get(a, &movement_id)
            .await?
            .json::<Value>()
            .await
            .map_err(|_| ())?;
        if existing.get("pesaje_id").and_then(Value::as_str) == Some(pesaje_id)
            && existing.get("comercio_id").and_then(Value::as_str) == Some(comercio_id)
        {
            return Ok(existing);
        }
    }
    Err(())
}
async fn reconcile_verified_pesajes(a: &App) -> Result<usize, ()> {
    let mut bookmark: Option<String> = None;
    let mut reconciled = 0;
    loop {
        let mut query = json!({
            "selector": {"type":"pesaje","estado":"verificado"},
            "limit": 500,
            "fields": ["_id","_rev","type","estado","comercio_id","lineas","capturado_en","verificado_en"]
        });
        if let Some(cursor) = bookmark.as_deref() {
            query["bookmark"] = json!(cursor);
        }
        let response = a
            .http
            .post(format!("{}/{}/_find", a.couch, a.db))
            .basic_auth(&a.db_user, Some(&a.db_password))
            .json(&query)
            .send()
            .await
            .map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        let page = response.json::<Value>().await.map_err(|_| ())?;
        let docs = page
            .get("docs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = docs.len();
        for pesaje in docs {
            ensure_points_for_pesaje(a, &pesaje).await?;
            reconciled += 1;
        }
        if count < 500 {
            break;
        }
        bookmark = page
            .get("bookmark")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if bookmark.is_none() {
            break;
        }
    }
    Ok(reconciled)
}
async fn get_doc(
    State(a): State<Arc<App>>,
    axum::Extension(c): axum::Extension<Claims>,
    Path(id): Path<String>,
) -> Response {
    if id.len() > 240 {
        return err(StatusCode::BAD_REQUEST);
    }
    let r = a
        .http
        .get(format!("{}/{}/{}", a.couch, a.db, urlencoding::encode(&id)))
        .header("X-Auth-CouchDB-User", &c.sub)
        .header("X-Auth-CouchDB-Roles", &c.role)
        .header("X-Auth-CouchDB-Token", &a.proxy_secret)
        .send()
        .await;
    let Ok(r) = r else {
        return err(StatusCode::SERVICE_UNAVAILABLE);
    };
    if r.status().as_u16() == StatusCode::NOT_FOUND.as_u16() {
        return err(StatusCode::NOT_FOUND);
    }
    let Ok(d) = r.json::<Value>().await else {
        return err(StatusCode::BAD_GATEWAY);
    };
    if !can_read(&c, &d) {
        return err(StatusCode::FORBIDDEN);
    }
    Json(d).into_response()
}
async fn list_docs(
    State(a): State<Arc<App>>,
    axum::Extension(c): axum::Extension<Claims>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let kind = q.get("type").map(String::as_str).unwrap_or("");
    if !matches!(
        kind,
        "comercio" | "solicitud_recoleccion" | "pesaje" | "movimiento_puntos"
    ) {
        return err(StatusCode::BAD_REQUEST);
    }
    let mut request = json!({"selector":{"type":kind},"limit":500,"fields":["_id","_rev","type","nombre","giro","zona","activo","creado_en","estado","solicitud_id","comercio_id","recolector_id","lineas","capturado_en","verificado_en","puntos","origen","concepto","fecha_solicitada","observaciones","creada_en","pesaje_id","regla_version"]});
    if let Some(bookmark) = q.get("bookmark").filter(|v| !v.is_empty()) {
        request["bookmark"] = json!(bookmark);
    }
    let result = a
        .http
        .post(format!("{}/{}/_find", a.couch, a.db))
        .header("X-Auth-CouchDB-User", &c.sub)
        .header("X-Auth-CouchDB-Roles", &c.role)
        .header("X-Auth-CouchDB-Token", &a.proxy_secret)
        .json(&request)
        .send()
        .await;
    let Ok(result) = result else {
        return err(StatusCode::SERVICE_UNAVAILABLE);
    };
    if !result.status().is_success() {
        return err(StatusCode::BAD_GATEWAY);
    }
    let Ok(value) = result.json::<Value>().await else {
        return err(StatusCode::BAD_GATEWAY);
    };
    let page_docs = value
        .get("docs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_more = page_docs.len() == 500;
    let docs = page_docs
        .into_iter()
        .filter(|d| can_read(&c, d))
        .collect::<Vec<_>>();
    Json(json!({"docs":docs,"bookmark":value.get("bookmark"),"has_more":has_more})).into_response()
}
async fn changes(
    State(a): State<Arc<App>>,
    axum::Extension(c): axum::Extension<Claims>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let since = q.get("since").map(String::as_str).unwrap_or("0");
    if since.len() > 2048 {
        return err(StatusCode::BAD_REQUEST);
    }
    let result = a
        .http
        .get(format!("{}/{}/_changes", a.couch, a.db))
        .query(&[("since", since), ("include_docs", "true"), ("limit", "500")])
        .header("X-Auth-CouchDB-User", &c.sub)
        .header("X-Auth-CouchDB-Roles", &c.role)
        .header("X-Auth-CouchDB-Token", &a.proxy_secret)
        .send()
        .await;
    let Ok(result) = result else {
        return err(StatusCode::SERVICE_UNAVAILABLE);
    };
    if !result.status().is_success() {
        return err(StatusCode::BAD_GATEWAY);
    }
    let Ok(value) = result.json::<Value>().await else {
        return err(StatusCode::BAD_GATEWAY);
    };
    let rows = value
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_more = rows.len() == 500;
    let results = rows
        .into_iter()
        .filter(|row| row.get("doc").is_some_and(|doc| can_read(&c, doc)))
        .collect::<Vec<_>>();
    Json(json!({"results":results,"last_seq":value.get("last_seq"),"has_more":has_more}))
        .into_response()
}
async fn points_balance(
    State(a): State<Arc<App>>,
    axum::Extension(c): axum::Extension<Claims>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let requested = q.get("comercio_id").map(String::as_str).unwrap_or("");
    let comercio_id = match c.role.as_str() {
        "comercio" => {
            let Some(own) = c.comercio_id.as_deref() else {
                return err(StatusCode::FORBIDDEN);
            };
            if !requested.is_empty() && requested != own {
                return err(StatusCode::FORBIDDEN);
            }
            own
        }
        "admin_plataforma" | "operador_acopio" => {
            if requested.is_empty() || requested.len() > 200 {
                return err(StatusCode::BAD_REQUEST);
            }
            requested
        }
        _ => return err(StatusCode::FORBIDDEN),
    };
    let mut bookmark: Option<String> = None;
    let mut movements = Vec::new();
    loop {
        let mut query = json!({"selector":{"type":"movimiento_puntos","comercio_id":comercio_id},"limit":500,"fields":["_id","_rev","type","comercio_id","origen","puntos","concepto","creado_en","pesaje_id","regla_version"]});
        if let Some(cursor) = bookmark.as_deref() {
            query["bookmark"] = json!(cursor)
        }
        let response = a
            .http
            .post(format!("{}/{}/_find", a.couch, a.db))
            .header("X-Auth-CouchDB-User", &c.sub)
            .header("X-Auth-CouchDB-Roles", &c.role)
            .header("X-Auth-CouchDB-Token", &a.proxy_secret)
            .json(&query)
            .send()
            .await;
        let Ok(response) = response else {
            return err(StatusCode::SERVICE_UNAVAILABLE);
        };
        if !response.status().is_success() {
            return err(StatusCode::BAD_GATEWAY);
        }
        let Ok(page) = response.json::<Value>().await else {
            return err(StatusCode::BAD_GATEWAY);
        };
        let docs = page
            .get("docs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = docs.len();
        movements.extend(docs);
        if count < 500 {
            break;
        }
        bookmark = page
            .get("bookmark")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if bookmark.is_none() {
            break;
        }
    }
    let Some(balance) = movements.iter().try_fold(0_i64, |sum, movement| {
        let value = movement.get("puntos")?.as_i64()?;
        let signed = if movement.get("concepto").and_then(Value::as_str) == Some("canje") {
            value.checked_neg()?
        } else {
            value
        };
        sum.checked_add(signed)
    }) else {
        return err(StatusCode::BAD_GATEWAY);
    };
    Json(json!({"comercio_id":comercio_id,"saldo":balance,"movimientos":movements})).into_response()
}
fn domain_error(
    code: StatusCode,
    reason: &'static str,
    message: &'static str,
    c: &Claims,
) -> Response {
    tracing::warn!(reason, status = code.as_u16(), role = %c.role, "Business rule rejected request");
    (code, Json(json!({"error":reason,"message":message}))).into_response()
}
fn validate_request_transition(c: &Claims, old: Option<&Value>, next: &Value) -> Option<Response> {
    let state = next.get("estado").and_then(Value::as_str).unwrap_or("");
    let old_state = old.and_then(|v| v.get("estado")).and_then(Value::as_str);
    let commerce = next
        .get("comercio_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if commerce.is_empty()
        || commerce.len() > 200
        || next
            .get("observaciones")
            .and_then(Value::as_str)
            .is_some_and(|v| v.len() > 1000)
    {
        return Some(domain_error(
            StatusCode::BAD_REQUEST,
            "solicitud_invalida",
            "Indica un comercio válido y observaciones de hasta 1,000 caracteres.",
            c,
        ));
    }
    let valid = match (c.role.as_str(), old_state, state) {
        ("comercio", None, "pendiente") => true,
        ("comercio", Some("pendiente"), "pendiente" | "cancelada") => true,
        ("admin_plataforma" | "operador_acopio", None, "pendiente") => true,
        (
            "admin_plataforma" | "operador_acopio",
            Some("pendiente"),
            "aprobada" | "rechazada" | "cancelada",
        ) => true,
        ("admin_plataforma" | "operador_acopio", Some("aprobada"), "asignada" | "cancelada") => {
            true
        }
        ("admin_plataforma" | "operador_acopio", Some("asignada"), "completada" | "cancelada") => {
            true
        }
        _ => false,
    };
    if !valid {
        return Some(domain_error(
            StatusCode::CONFLICT,
            "transicion_estado_invalida",
            "La solicitud no puede pasar de su estado actual al estado indicado.",
            c,
        ));
    }
    if old.is_some_and(|v| v.get("comercio_id").and_then(Value::as_str) != Some(commerce)) {
        return Some(domain_error(
            StatusCode::CONFLICT,
            "comercio_no_coincide",
            "El comercio de una solicitud existente no se puede cambiar.",
            c,
        ));
    }
    None
}
async fn validate_weighing(
    a: &App,
    c: &Claims,
    old: Option<&Value>,
    d: &Value,
) -> Option<Response> {
    let reject = |code, reason, message| Some(domain_error(code, reason, message, c));
    let state = d.get("estado").and_then(Value::as_str).unwrap_or("");
    if !matches!(state, "pendiente_verificacion" | "verificado") {
        return reject(
            StatusCode::BAD_REQUEST,
            "estado_pesaje_invalido",
            "El estado del pesaje no es válido.",
        );
    }
    if state == "verificado"
        && old.and_then(|v| v.get("estado")).and_then(Value::as_str) == Some("verificado")
    {
        if old.is_some_and(|v| same_verification_event(v, d)) {
            return None;
        }
        return reject(
            StatusCode::CONFLICT,
            "pesaje_verificado_inmutable",
            "El pesaje ya fue verificado y no se puede alterar.",
        );
    }
    let commerce = d.get("comercio_id").and_then(Value::as_str).unwrap_or("");
    if commerce.is_empty()
        || commerce.len() > 200
        || old.is_some_and(|v| v.get("comercio_id").and_then(Value::as_str) != Some(commerce))
    {
        return reject(
            StatusCode::BAD_REQUEST,
            "comercio_no_coincide",
            "El pesaje debe conservar un identificador de comercio válido.",
        );
    }
    let Some(lines) = d
        .get("lineas")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty() && v.len() <= 10)
    else {
        return reject(
            StatusCode::BAD_REQUEST,
            "lineas_pesaje_invalidas",
            "El pesaje requiere entre 1 y 10 líneas de material.",
        );
    };
    let mut total = 0.0_f64;
    for line in lines {
        let material = line
            .get("material")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let weight = line
            .get("peso_kg")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN);
        if !matches!(
            material.as_str(),
            "carton" | "papel" | "plastico" | "vidrio" | "metal" | "aluminio"
        ) {
            return reject(
                StatusCode::BAD_REQUEST,
                "material_no_permitido",
                "El material no está habilitado para recibir puntos.",
            );
        }
        if !weight.is_finite() || !(0.01..=1_000.0).contains(&weight) {
            return reject(
                StatusCode::BAD_REQUEST,
                "peso_fuera_rango",
                "Cada línea debe tener un peso entre 0.01 y 1,000 kg.",
            );
        }
        total += weight;
    }
    if total > 2_000.0 {
        return reject(
            StatusCode::BAD_REQUEST,
            "peso_total_fuera_rango",
            "El peso total de un pesaje no puede superar 2,000 kg.",
        );
    }
    let captured = d
        .get("capturado_en")
        .and_then(Value::as_str)
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok());
    let Some(captured) = captured else {
        return reject(
            StatusCode::BAD_REQUEST,
            "fecha_pesaje_invalida",
            "La fecha de captura debe ser una fecha ISO válida.",
        );
    };
    let now = Utc::now();
    if captured > now + Duration::minutes(5) || captured < now - Duration::days(30) {
        return reject(
            StatusCode::BAD_REQUEST,
            "fecha_pesaje_fuera_rango",
            "La fecha de captura debe estar dentro de los últimos 30 días y no en el futuro.",
        );
    }
    if let Some(request_id) = d.get("solicitud_id").and_then(Value::as_str) {
        let request = match couch_get(a, request_id).await {
            Ok(response) if response.status().is_success() => response.json::<Value>().await.ok(),
            _ => None,
        };
        let Some(request) = request else {
            return reject(
                StatusCode::BAD_REQUEST,
                "solicitud_no_valida",
                "La solicitud asociada no existe o no está disponible.",
            );
        };
        if request.get("type").and_then(Value::as_str) != Some("solicitud_recoleccion")
            || request.get("comercio_id").and_then(Value::as_str) != Some(commerce)
            || !matches!(
                request.get("estado").and_then(Value::as_str),
                Some("aprobada" | "asignada")
            )
        {
            return reject(
                StatusCode::CONFLICT,
                "solicitud_no_aprobada",
                "El pesaje debe corresponder al comercio de una solicitud aprobada o asignada.",
            );
        }
        if request
            .get("recolector_id")
            .and_then(Value::as_str)
            .is_some_and(|id| id != c.sub)
        {
            return reject(
                StatusCode::FORBIDDEN,
                "recolector_no_asignado",
                "La solicitud está asignada a otro recolector.",
            );
        }
    }
    if state == "verificado"
        && old.and_then(|v| v.get("estado")).and_then(Value::as_str)
            != Some("pendiente_verificacion")
    {
        return reject(
            StatusCode::CONFLICT,
            "flujo_verificacion_invalido",
            "Solo se pueden verificar pesajes pendientes.",
        );
    }
    if state == "verificado"
        && old.is_some_and(|v| {
            [
                "comercio_id",
                "recolector_id",
                "solicitud_id",
                "capturado_en",
                "lineas",
            ]
            .iter()
            .any(|key| v.get(*key) != d.get(*key))
        })
    {
        return reject(
            StatusCode::CONFLICT,
            "datos_pesaje_alterados",
            "La verificación debe conservar los datos originales de captura.",
        );
    }
    if old.is_none()
        || old.and_then(|v| v.get("estado")).and_then(Value::as_str)
            == Some("pendiente_verificacion")
    {
        let selector = if let Some(request_id) = d.get("solicitud_id").and_then(Value::as_str) {
            json!({"type":"pesaje","solicitud_id":request_id,"estado":{"$ne":"rechazado"}})
        } else {
            json!({"type":"pesaje","recolector_id":c.sub,"comercio_id":commerce,"solicitud_id":{"$exists":false},"capturado_en":{"$gte":(now-Duration::hours(1)).to_rfc3339()}})
        };
        let response = a
            .http
            .post(format!("{}/{}/_find", a.couch, a.db))
            .basic_auth(&a.db_user, Some(&a.db_password))
            .json(&json!({"selector":selector,"limit":100}))
            .send()
            .await;
        let docs = match response {
            Ok(response) if response.status().is_success() => response
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("docs").and_then(Value::as_array).cloned())
                .unwrap_or_default(),
            _ => {
                return reject(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "validacion_no_disponible",
                    "No se pudo completar la validación de duplicados; intenta de nuevo.",
                )
            }
        };
        let id = d.get("_id").and_then(Value::as_str).unwrap_or("");
        if docs.iter().any(|v| {
            v.get("_id").and_then(Value::as_str) != Some(id) && d.get("solicitud_id").is_some()
        }) {
            return reject(
                StatusCode::CONFLICT,
                "pesaje_duplicado",
                "Ya existe un pesaje registrado para esta solicitud.",
            );
        }
        if d.get("solicitud_id").is_none()
            && docs
                .iter()
                .filter(|v| v.get("_id").and_then(Value::as_str) != Some(id))
                .count()
                >= 8
        {
            return reject(
                StatusCode::TOO_MANY_REQUESTS,
                "frecuencia_sospechosa",
                "Se alcanzó el límite de 8 pesajes por hora para este recolector y comercio.",
            );
        }
    }
    None
}
async fn put_doc(
    State(a): State<Arc<App>>,
    axum::Extension(c): axum::Extension<Claims>,
    Path(id): Path<String>,
    Json(input): Json<DocInput>,
) -> Response {
    if id.trim().is_empty() || id.len() > 200 || input.body.as_object().is_none() {
        return domain_error(
            StatusCode::BAD_REQUEST,
            "datos_invalidos",
            "El registro tiene un formato inválido.",
            &c,
        );
    }
    let mut d = input.body;
    if d.get("_id")
        .and_then(Value::as_str)
        .is_some_and(|x| x != id)
    {
        return domain_error(
            StatusCode::BAD_REQUEST,
            "identificador_invalido",
            "El identificador no coincide con el registro.",
            &c,
        );
    }
    d["_id"] = json!(id);
    let kind = d.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "movimiento_puntos" || kind == "config_puntos" {
        return domain_error(
            StatusCode::FORBIDDEN,
            "tipo_protegido",
            "Este tipo de registro solo puede generarlo el sistema.",
            &c,
        );
    }
    if !matches!(kind, "comercio" | "solicitud_recoleccion" | "pesaje") {
        return domain_error(
            StatusCode::BAD_REQUEST,
            "tipo_no_permitido",
            "El tipo de registro no está permitido.",
            &c,
        );
    }
    if c.role == "recolector" {
        d["recolector_id"] = json!(c.sub);
        d["estado"] = json!("pendiente_verificacion");
    }
    let verified =
        kind == "pesaje" && d.get("estado").and_then(Value::as_str) == Some("verificado");
    if !can_write(&c, &d) {
        return domain_error(
            StatusCode::FORBIDDEN,
            "permiso_insuficiente",
            "Tu rol no puede realizar este cambio.",
            &c,
        );
    }
    let existing = match get_doc_for_role(&a, &c, &id).await {
        Ok(doc) => doc,
        Err(_) => return err(StatusCode::SERVICE_UNAVAILABLE),
    };
    if kind == "solicitud_recoleccion" {
        if let Some(response) = validate_request_transition(&c, existing.as_ref(), &d) {
            return response;
        }
    }
    if kind == "pesaje" {
        if let Some(response) = validate_weighing(&a, &c, existing.as_ref(), &d).await {
            return response;
        }
    }
    if verified {
        if d.get("verificado_en").and_then(Value::as_str).is_none() {
            d["verificado_en"] = json!(Utc::now().to_rfc3339());
        }
        if d.get("comercio_id").and_then(Value::as_str).is_none()
            || d.get("lineas").and_then(Value::as_array).is_none()
        {
            return domain_error(
                StatusCode::BAD_REQUEST,
                "datos_pesaje_incompletos",
                "El pesaje requiere comercio y al menos una línea de material.",
                &c,
            );
        }
        if calculate_points(&a, &d).await.is_err() {
            return domain_error(StatusCode::BAD_REQUEST, "material_o_peso_invalido", "Revisa los materiales y pesos: cada línea debe ser válida y el total no puede superar 2,000 kg.", &c);
        }
    }
    if kind == "pesaje" {
        match get_doc_for_role(&a, &c, &id).await {
            Ok(Some(existing))
                if existing.get("estado").and_then(Value::as_str) == Some("verificado") =>
            {
                if !verified || !same_verification_event(&existing, &d) {
                    return domain_error(
                        StatusCode::CONFLICT,
                        "pesaje_verificado_inmutable",
                        "El pesaje ya fue verificado y no se puede alterar.",
                        &c,
                    );
                }
                if ensure_points_for_pesaje(&a, &existing).await.is_err() {
                    return err(StatusCode::SERVICE_UNAVAILABLE);
                }
                return (
                    StatusCode::OK,
                    Json(json!({"ok":true,"rev":existing.get("_rev"),"points_awarded":true})),
                )
                    .into_response();
            }
            Ok(Some(_)) => {}
            Ok(None) if verified => return err(StatusCode::BAD_REQUEST),
            Ok(None) => {}
            Err(_) if verified => return err(StatusCode::SERVICE_UNAVAILABLE),
            Err(_) => {}
        }
    }
    let write = a
        .http
        .put(format!("{}/{}/{}", a.couch, a.db, urlencoding::encode(&id)))
        .header("X-Auth-CouchDB-User", &c.sub)
        .header("X-Auth-CouchDB-Roles", &c.role)
        .header("X-Auth-CouchDB-Token", &a.proxy_secret)
        .json(&d)
        .send()
        .await;
    let Ok(write) = write else {
        return err(StatusCode::SERVICE_UNAVAILABLE);
    };
    if write.status().is_success() {
        let saved = write.json::<Value>().await.unwrap_or_default();
        if verified {
            if ensure_points_for_pesaje(&a, &d).await.is_err() {
                return err(StatusCode::SERVICE_UNAVAILABLE);
            }
        }
        return (
            StatusCode::CREATED,
            Json(json!({"ok":true,"rev":saved.get("rev"),"points_awarded":verified})),
        )
            .into_response();
    }
    if write.status().as_u16() == StatusCode::CONFLICT.as_u16() && verified {
        let existing = match get_doc_for_role(&a, &c, &id).await {
            Ok(Some(doc)) => doc,
            Ok(None) => return err(StatusCode::CONFLICT),
            Err(_) => return err(StatusCode::SERVICE_UNAVAILABLE),
        };
        if existing.get("estado").and_then(Value::as_str) == Some("verificado")
            && same_verification_event(&existing, &d)
        {
            if ensure_points_for_pesaje(&a, &existing).await.is_err() {
                return err(StatusCode::SERVICE_UNAVAILABLE);
            }
            return (
                StatusCode::OK,
                Json(json!({"ok":true,"rev":existing.get("_rev"),"points_awarded":true})),
            )
                .into_response();
        }
    }
    if write.status().as_u16() == StatusCode::CONFLICT.as_u16() {
        return err(StatusCode::CONFLICT);
    }
    err(StatusCode::SERVICE_UNAVAILABLE)
}
async fn get_doc_for_role(a: &App, c: &Claims, id: &str) -> Result<Option<Value>, ()> {
    let response = a
        .http
        .get(format!("{}/{}/{}", a.couch, a.db, urlencoding::encode(id)))
        .header("X-Auth-CouchDB-User", &c.sub)
        .header("X-Auth-CouchDB-Roles", &c.role)
        .header("X-Auth-CouchDB-Token", &a.proxy_secret)
        .send()
        .await
        .map_err(|_| ())?;
    if response.status().as_u16() == StatusCode::NOT_FOUND.as_u16() {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(());
    }
    response.json::<Value>().await.map(Some).map_err(|_| ())
}
fn same_verification_event(left: &Value, right: &Value) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    if let Some(obj) = left.as_object_mut() {
        obj.remove("_rev");
        obj.remove("verificado_en");
    }
    if let Some(obj) = right.as_object_mut() {
        obj.remove("_rev");
        obj.remove("verificado_en");
    }
    left == right
}
async fn create_user(
    State(a): State<Arc<App>>,
    axum::Extension(c): axum::Extension<Claims>,
    Json(u): Json<NewUser>,
) -> Response {
    if c.role != "admin_plataforma" {
        return err(StatusCode::FORBIDDEN);
    }

    if u.username.len() < 3
        || u.username.len() > 80
        || u.password.len() < 12
        || u.password.len() > 256
        || !valid_role(&u.role)
        || (u.role == "comercio" && u.comercio_id.is_none())
    {
        return err(StatusCode::BAD_REQUEST);
    }
    let v = json!({"name":u.username,"roles":[u.role],"type":"user","password":u.password,"comercio_id":u.comercio_id});
    let r = a
        .http
        .put(format!(
            "{}/_users/org.couchdb.user:{}",
            a.couch,
            urlencoding::encode(&u.username)
        ))
        .basic_auth(&a.db_user, Some(&a.db_password))
        .json(&v)
        .send()
        .await;
    match r {
        Ok(r) if r.status().is_success() => {
            (StatusCode::CREATED, Json(json!({"ok":true}))).into_response()
        }
        Ok(r) if r.status().as_u16() == StatusCode::CONFLICT.as_u16() => err(StatusCode::CONFLICT),
        _ => err(StatusCode::SERVICE_UNAVAILABLE),
    }
}
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().json().init();
    let required =
        |k: &str| env::var(k).unwrap_or_else(|_| panic!("Falta variable requerida: {k}"));
    let a = Arc::new(App {
        http: Client::new(),
        couch: required("COUCHDB_URL"),
        db: env::var("COUCHDB_DB").unwrap_or_else(|_| "reciclaje".into()),
        db_user: required("COUCHDB_USER"),
        db_password: required("COUCHDB_PASSWORD"),
        secret: required("JWT_SECRET"),
        proxy_secret: required("COUCHDB_PROXY_SECRET"),
    });
    assert!(
        a.secret.len() >= 32 && a.proxy_secret.len() >= 32,
        "JWT_SECRET y COUCHDB_PROXY_SECRET deben tener al menos 32 caracteres"
    );
    let reconciliation_app = a.clone();
    tokio::spawn(async move {
        loop {
            match reconcile_verified_pesajes(&reconciliation_app).await {
                Ok(count) if count > 0 => {
                    tracing::debug!(count, "Pesajes verificados conciliados con el ledger")
                }
                Err(()) => {
                    tracing::warn!("No se pudo completar la conciliación automática de puntos")
                }
                _ => {}
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
    let protected: Router<Arc<App>> = Router::new()
        .route("/api/users", post(create_user))
        .route("/api/points/balance", get(points_balance))
        .route("/api/changes", get(changes))
        .route("/api/docs", get(list_docs))
        .route("/api/docs/:id", get(get_doc).put(put_doc))
        .layer(middleware::from_fn_with_state(a.clone(), auth));
    let app: Router<Arc<App>> = Router::new()
        .route("/salud", get(|| async { "ok" }))
        .route("/auth/login", post(login))
        .merge(protected);
    let app: Router = app.with_state(a.clone());
    let l = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .expect("No se pudo enlazar puerto");
    axum::serve(l, app).await.expect("Error HTTP");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(role: &str) -> Claims {
        Claims {
            sub: "prueba".into(),
            role: role.into(),
            comercio_id: Some("comercio:prueba".into()),
            exp: 0,
        }
    }

    #[test]
    fn calcula_puntos_segun_material_y_peso() {
        let rules = json!({"version":1,"puntos_por_kg":{"carton":5,"plastico":10}});
        let pesaje = json!({"lineas":[{"material":"carton","peso_kg":10.0},{"material":"plastico","peso_kg":2.0}]});
        let (points, applied_rules) = calculate_points_with_rules(&pesaje, &rules).unwrap();
        assert_eq!(points, 70);
        assert_eq!(applied_rules["version"], 1);
    }

    #[test]
    fn rechaza_material_desconocido_peso_fuera_de_rango_y_exceso_de_lineas() {
        let rules = json!({"puntos_por_kg":{"carton":5}});
        assert!(calculate_points_with_rules(
            &json!({"lineas":[{"material":"organico","peso_kg":1.0}]}),
            &rules
        )
        .is_err());
        assert!(calculate_points_with_rules(
            &json!({"lineas":[{"material":"carton","peso_kg":1000.01}]}),
            &rules
        )
        .is_err());
        assert!(calculate_points_with_rules(
            &json!({"lineas":[{"material":"carton","peso_kg":1000.0},{"material":"carton","peso_kg":1000.0},{"material":"carton","peso_kg":1.0}]}),
            &rules
        )
        .is_err());
        let lines = (0..11)
            .map(|_| json!({"material":"carton","peso_kg":1.0}))
            .collect::<Vec<_>>();
        assert!(calculate_points_with_rules(&json!({"lineas":lines}), &rules).is_err());
    }

    #[test]
    fn aplica_transiciones_de_solicitud_por_rol_y_estado() {
        let operator = claims("operador_acopio");
        let old = json!({"type":"solicitud_recoleccion","comercio_id":"comercio:prueba","estado":"pendiente"});
        let approved = json!({"type":"solicitud_recoleccion","comercio_id":"comercio:prueba","estado":"aprobada"});
        assert!(validate_request_transition(&operator, Some(&old), &approved).is_none());
        let invalid = json!({"type":"solicitud_recoleccion","comercio_id":"comercio:prueba","estado":"completada"});
        assert!(validate_request_transition(&operator, Some(&old), &invalid).is_some());

        let commerce = claims("comercio");
        assert!(validate_request_transition(
            &commerce,
            None,
            &json!({"comercio_id":"comercio:prueba","estado":"pendiente"})
        )
        .is_none());
        assert!(validate_request_transition(&commerce, None, &approved).is_some());
    }

    #[test]
    fn verificacion_repetida_conserva_un_mismo_evento_y_id_de_movimiento() {
        let original = json!({"_id":"pesaje:1","_rev":"1-a","estado":"verificado","lineas":[{"material":"carton","peso_kg":2.0}],"verificado_en":"2026-01-01T00:00:00Z"});
        let retry = json!({"_id":"pesaje:1","_rev":"2-b","estado":"verificado","lineas":[{"material":"carton","peso_kg":2.0}],"verificado_en":"2026-01-02T00:00:00Z"});
        assert!(same_verification_event(&original, &retry));
        assert_eq!(movement_id("pesaje:1"), "movimiento_puntos:pesaje:pesaje:1");
    }
}
