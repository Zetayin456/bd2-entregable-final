use axum::{extract::{Path, State}, http::{header, StatusCode}, middleware::{self, Next}, response::{IntoResponse, Response}, routing::{get, post}, Json, Router};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, sync::Arc};
use chrono::{Duration, Utc};

#[derive(Clone)] struct App { http: Client, couch: String, db: String, db_user: String, db_password: String, secret: String, proxy_secret: String }
#[derive(Clone, Serialize, Deserialize)] struct Claims { sub: String, role: String, #[serde(default)] comercio_id: Option<String>, exp: usize }
#[derive(Deserialize)] struct Login { username: String, password: String }
#[derive(Deserialize)] struct NewUser { username: String, password: String, role: String, comercio_id: Option<String> }
#[derive(Deserialize)] struct DocInput { #[serde(flatten)] body: Value }
fn err(code: StatusCode) -> Response { (code, Json(json!({"error": if code == StatusCode::UNAUTHORIZED {"no_autorizado"} else if code == StatusCode::FORBIDDEN {"prohibido"} else if code == StatusCode::NOT_FOUND {"no_encontrado"} else {"solicitud_invalida"}}))).into_response() }
fn valid_role(role: &str) -> bool { matches!(role, "admin_plataforma"|"operador_acopio"|"recolector"|"comercio") }
async fn login(State(a):State<Arc<App>>, Json(input):Json<Login>) -> Response {
 if input.username.len()>80 || input.password.len()>256 {return err(StatusCode::BAD_REQUEST)}
 let session=a.http.get(format!("{}/_session",a.couch)).basic_auth(&input.username,Some(&input.password)).send().await;
 let Ok(session)=session else{return err(StatusCode::SERVICE_UNAVAILABLE)};if !session.status().is_success(){return err(StatusCode::UNAUTHORIZED)}let Ok(sess)=session.json::<Value>().await else{return err(StatusCode::UNAUTHORIZED)};if sess.pointer("/userCtx/name").and_then(Value::as_str)!=Some(&input.username){return err(StatusCode::UNAUTHORIZED)}
 let userdoc=a.http.get(format!("{}/_users/org.couchdb.user:{}",a.couch,urlencoding::encode(&input.username))).basic_auth(&a.db_user,Some(&a.db_password)).send().await;
 let Ok(userdoc)=userdoc else{return err(StatusCode::SERVICE_UNAVAILABLE)};let Ok(v)=userdoc.json::<Value>().await else{return err(StatusCode::UNAUTHORIZED)};
 let Some(role)=v.get("roles").and_then(Value::as_array).and_then(|rs|rs.iter().filter_map(Value::as_str).find(|r|valid_role(r))) else{return err(StatusCode::UNAUTHORIZED)};
 if !valid_role(role) {return err(StatusCode::UNAUTHORIZED)}
 let comercio_id=v.get("comercio_id").and_then(Value::as_str).map(str::to_owned);
 let claims=Claims{sub:input.username,role:role.to_owned(),comercio_id,exp:(Utc::now()+Duration::hours(8)).timestamp() as usize};
 match encode(&Header::default(),&claims,&EncodingKey::from_secret(a.secret.as_bytes())) {Ok(token)=>(StatusCode::OK,Json(json!({"token":token,"role":claims.role,"expires_in":28800}))).into_response(),Err(_)=>err(StatusCode::INTERNAL_SERVER_ERROR)}
}
async fn auth(State(a):State<Arc<App>>, mut req:axum::http::Request<axum::body::Body>, next:Next)->Response{
 let token=req.headers().get(header::AUTHORIZATION).and_then(|h|h.to_str().ok()).and_then(|v|v.strip_prefix("Bearer "));
 let Some(token)=token else{return err(StatusCode::UNAUTHORIZED)};
 let Ok(data)=decode::<Claims>(token,&DecodingKey::from_secret(a.secret.as_bytes()),&Validation::default()) else{return err(StatusCode::UNAUTHORIZED)};
 req.extensions_mut().insert(data.claims);next.run(req).await
}
fn can_read(c:&Claims,d:&Value)->bool { match c.role.as_str(){"admin_plataforma"|"operador_acopio"=>true,"recolector"=>d.get("recolector_id").and_then(Value::as_str)==Some(&c.sub),"comercio"=>c.comercio_id.as_deref().is_some_and(|id|d.get("comercio_id").and_then(Value::as_str)==Some(id)||d.get("_id").and_then(Value::as_str)==Some(id)),_=>false} }
fn can_write(c:&Claims,d:&Value)->bool { let typ=d.get("type").and_then(Value::as_str).unwrap_or(""); match c.role.as_str(){"admin_plataforma"=>true,"operador_acopio"=>typ=="comercio"||typ=="movimiento_puntos"||typ=="pesaje"&&d.get("estado").and_then(Value::as_str)==Some("verificado"),"recolector"=>typ=="pesaje"&&d.get("recolector_id").and_then(Value::as_str)==Some(&c.sub)&&d.get("estado").and_then(Value::as_str)!=Some("verificado"),"comercio"=>typ=="solicitud_recoleccion"&&c.comercio_id.as_deref().is_some_and(|id|d.get("comercio_id").and_then(Value::as_str)==Some(id)),_=>false} }
async fn get_doc(State(a):State<Arc<App>>, axum::Extension(c):axum::Extension<Claims>,Path(id):Path<String>)->Response{ if id.len()>240{return err(StatusCode::BAD_REQUEST)} let r=a.http.get(format!("{}/{}/{}",a.couch,a.db,urlencoding::encode(&id))).header("X-Auth-CouchDB-User",&c.sub).header("X-Auth-CouchDB-Roles",&c.role).header("X-Auth-CouchDB-Token",&a.proxy_secret).send().await; let Ok(r)=r else{return err(StatusCode::SERVICE_UNAVAILABLE)};if r.status().as_u16()==StatusCode::NOT_FOUND.as_u16(){return err(StatusCode::NOT_FOUND)}let Ok(d)=r.json::<Value>().await else{return err(StatusCode::BAD_GATEWAY)};if !can_read(&c,&d){return err(StatusCode::FORBIDDEN)}Json(d).into_response() }
async fn put_doc(State(a):State<Arc<App>>,axum::Extension(c):axum::Extension<Claims>,Path(id):Path<String>,Json(input):Json<DocInput>)->Response{if id.len()>240||input.body.as_object().is_none(){return err(StatusCode::BAD_REQUEST)}let mut d=input.body;if d.get("_id").and_then(Value::as_str).is_some_and(|x|x!=id){return err(StatusCode::BAD_REQUEST)} d["_id"]=json!(id); if c.role=="recolector" {d["recolector_id"]=json!(c.sub); d["estado"]=json!("pendiente_verificacion");}

    if !can_write(&c,&d){return err(StatusCode::FORBIDDEN)} let r=a.http.put(format!("{}/{}/{}",a.couch,a.db,urlencoding::encode(&id))).header("X-Auth-CouchDB-User",&c.sub).header("X-Auth-CouchDB-Roles",&c.role).header("X-Auth-CouchDB-Token",&a.proxy_secret).json(&d).send().await;match r{Ok(r) if r.status().is_success()=>(StatusCode::CREATED,Json(json!({"ok":true}))).into_response(),Ok(r) if r.status().as_u16()==StatusCode::CONFLICT.as_u16()=>err(StatusCode::CONFLICT),_=>err(StatusCode::SERVICE_UNAVAILABLE)} }
async fn create_user(State(a):State<Arc<App>>,axum::Extension(c):axum::Extension<Claims>,Json(u):Json<NewUser>)->Response{if c.role!="admin_plataforma"{return err(StatusCode::FORBIDDEN)}

    if u.username.len()<3||u.username.len()>80||u.password.len()<12||u.password.len()>256||!valid_role(&u.role)||(u.role=="comercio"&&u.comercio_id.is_none()){return err(StatusCode::BAD_REQUEST)}let v=json!({"name":u.username,"roles":[u.role],"type":"user","password":u.password,"comercio_id":u.comercio_id});let r=a.http.put(format!("{}/_users/org.couchdb.user:{}",a.couch,urlencoding::encode(&u.username))).basic_auth(&a.db_user,Some(&a.db_password)).json(&v).send().await;match r{Ok(r) if r.status().is_success()=>(StatusCode::CREATED,Json(json!({"ok":true}))).into_response(),Ok(r) if r.status().as_u16()==StatusCode::CONFLICT.as_u16()=>err(StatusCode::CONFLICT),_=>err(StatusCode::SERVICE_UNAVAILABLE)} }
#[tokio::main] async fn main(){tracing_subscriber::fmt().json().init();let required=|k:&str|env::var(k).unwrap_or_else(|_|panic!("Falta variable requerida: {k}"));let a=Arc::new(App{http:Client::new(),couch:required("COUCHDB_URL"),db:env::var("COUCHDB_DB").unwrap_or_else(|_|"reciclaje".into()),db_user:required("COUCHDB_USER"),db_password:required("COUCHDB_PASSWORD"),secret:required("JWT_SECRET"),proxy_secret:required("COUCHDB_PROXY_SECRET")});assert!(a.secret.len()>=32&&a.proxy_secret.len()>=32,"JWT_SECRET y COUCHDB_PROXY_SECRET deben tener al menos 32 caracteres");let protected: Router<Arc<App>>=Router::new().route("/api/users",post(create_user)).route("/api/docs/:id",get(get_doc).put(put_doc)).layer(middleware::from_fn_with_state(a.clone(),auth));let app: Router<Arc<App>>=Router::new().route("/salud",get(||async{"ok"})).route("/auth/login",post(login)).merge(protected);let app: Router=app.with_state(a.clone());let l=tokio::net::TcpListener::bind("0.0.0.0:8080").await.expect("No se pudo enlazar puerto");axum::serve(l,app).await.expect("Error HTTP");}
