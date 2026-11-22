use axum::{body::Body, middleware::Next, response::Response};
use metrics::{counter, histogram};
use std::time::Instant;

fn endpoint_label(method: &str, path: &str) -> &'static str {
    match (method, path) {
        ("GET", "/salud") => "/salud",
        ("POST", "/auth/login") => "/auth/login",
        ("GET", "/metrics") => "/metrics",
        ("POST", "/api/users") => "/api/users",
        ("GET", "/api/rewards") => "/api/rewards",
        ("GET", "/api/collectors") => "/api/collectors",
        ("GET", "/api/points/balance") => "/api/points/balance",
        ("GET", "/api/changes") => "/api/changes",
        ("GET", "/api/docs") | ("PUT", "/api/docs") => "/api/docs",
        _ if path.starts_with("/api/docs/") => "/api/docs/:id",
        _ if path.starts_with("/api/rewards/") && path.ends_with("/redeem") => {
            "/api/rewards/:id/redeem"
        }
        _ => "/other",
    }
}

pub(crate) async fn instrument_requests(
    request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    let method = request.method().as_str().to_owned();
    let route = endpoint_label(&method, request.uri().path());
    let started = Instant::now();
    let response = next.run(request).await;
    if route != "/metrics" {
        let status = response.status().as_u16().to_string();
        counter!("http_requests_total", "method" => method.clone(), "route" => route, "status" => status)
            .increment(1);
        histogram!("http_request_duration_seconds", "method" => method.clone(), "route" => route)
            .record(started.elapsed().as_secs_f64());
    }
    response
}

pub(crate) fn record_business_event(event: &'static str) {
    counter!("business_events_total", "event" => event).increment(1);
}

pub(crate) fn record_document_event(kind: &str, state: Option<&str>) {
    let event = match (kind, state) {
        ("comercio", _) => "commerce_registered",
        ("solicitud_recoleccion", Some("pendiente")) => "collection_request_created",
        ("solicitud_recoleccion", Some("aprobada")) => "collection_request_approved",
        ("solicitud_recoleccion", Some("asignada")) => "collection_request_assigned",
        ("solicitud_recoleccion", Some("completada")) => "collection_request_completed",
        ("solicitud_recoleccion", Some("rechazada")) => "collection_request_rejected",
        ("solicitud_recoleccion", Some("cancelada")) => "collection_request_cancelled",
        ("pesaje", Some("verificado")) => "weighing_verified",
        ("pesaje", _) => "weighing_captured",
        _ => "document_written",
    };
    record_business_event(event);
}

#[cfg(test)]
mod tests {
    use super::endpoint_label;

    #[test]
    fn rutas_de_metricas_normalizan_identificadores_y_metodos() {
        assert_eq!(
            endpoint_label("PUT", "/api/docs/pesaje:123"),
            "/api/docs/:id"
        );
        assert_eq!(
            endpoint_label("POST", "/api/rewards/recompensa:abc/redeem"),
            "/api/rewards/:id/redeem"
        );
        assert_eq!(
            endpoint_label("GET", "/api/points/balance"),
            "/api/points/balance"
        );
        assert_eq!(endpoint_label("GET", "/unmatched/123"), "/other");
    }
}
