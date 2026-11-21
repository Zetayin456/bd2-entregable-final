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
    let rates = rules
        .get("puntos_por_kg")
        .and_then(Value::as_object)
        .ok_or(())?;
    let lines = pesaje
        .get("lineas")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
        .ok_or(())?;
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
            .filter(|v| v.is_finite() && *v > 0.0 && *v <= 100_000.0)
            .ok_or(())?;
        let rate = rates
            .get(&material)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v > 0.0 && *v <= 1_000_000.0)
            .ok_or(())?;
        total += weight * rate;
    }
    if !total.is_finite() || total > i64::MAX as f64 {
        return Err(());
    }
    let points = total.round() as i64;
    if points <= 0 {
        return Err(());
    }
    Ok((points, rules))
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
async fn put_doc(
    State(a): State<Arc<App>>,
    axum::Extension(c): axum::Extension<Claims>,
    Path(id): Path<String>,
    Json(input): Json<DocInput>,
) -> Response {
    if id.len() > 200 || input.body.as_object().is_none() {
        return err(StatusCode::BAD_REQUEST);
    }
    let mut d = input.body;
    if d.get("_id")
        .and_then(Value::as_str)
        .is_some_and(|x| x != id)
    {
        return err(StatusCode::BAD_REQUEST);
    }
    d["_id"] = json!(id);
    let kind = d.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "movimiento_puntos" || kind == "config_puntos" {
        return err(StatusCode::FORBIDDEN);
    }
    if c.role == "recolector" {
        d["recolector_id"] = json!(c.sub);
        d["estado"] = json!("pendiente_verificacion");
    }
    let verified =
        kind == "pesaje" && d.get("estado").and_then(Value::as_str) == Some("verificado");
    if !can_write(&c, &d) {
        return err(StatusCode::FORBIDDEN);
    }
    if verified {
        if d.get("verificado_en").and_then(Value::as_str).is_none() {
            d["verificado_en"] = json!(Utc::now().to_rfc3339());
        }
        if d.get("comercio_id").and_then(Value::as_str).is_none()
            || d.get("lineas").and_then(Value::as_array).is_none()
        {
            return err(StatusCode::BAD_REQUEST);
        }
        if calculate_points(&a, &d).await.is_err() {
            return err(StatusCode::BAD_REQUEST);
        }
    }
    if kind == "pesaje" {
        match get_doc_for_role(&a, &c, &id).await {
            Ok(Some(existing))
                if existing.get("estado").and_then(Value::as_str) == Some("verificado") =>
            {
                if !verified || !same_verification_event(&existing, &d) {
                    return err(StatusCode::CONFLICT);
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
