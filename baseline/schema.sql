CREATE TABLE IF NOT EXISTS baseline_documents (
    id text PRIMARY KEY,
    document_type text NOT NULL,
    comercio_id text NOT NULL,
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS baseline_documents_type_idx
    ON baseline_documents (document_type);

CREATE INDEX IF NOT EXISTS baseline_documents_type_commerce_idx
    ON baseline_documents (document_type, comercio_id);
