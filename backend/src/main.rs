use axum::{routing::get, Router};

#[tokio::main]
async fn main() {
    // Definir las rutas básicas del backend de reciclaje
    let app = Router::new()
        .route("/salud", get(|| async { "ok" }))
        .route("/", get(|| async { "Backend de reciclaje activo" }));

    // Enlazar al puerto 8080 en todas las interfaces de red
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .expect("No se pudo enlazar el puerto 8080");
        
    println!("Backend de reciclaje iniciado correctamente.");
    
    // Iniciar el servidor Axum de manera bloqueante para que el contenedor no muera
    axum::serve(listener, app)
        .await
        .expect("Error al iniciar el servidor HTTP");
}